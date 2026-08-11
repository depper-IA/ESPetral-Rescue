/**
 * Hook de React para detección de patrones de golpe (knock patterns).
 * Integra con useAudioEngine para recibir picos y ejecutar la lógica de detección.
 *
 * Responsabilidades:
 * - Mantener ventana deslizante de picos (6 segundos)
 * - Calcular centroide espectral y filtrar picos inválidos
 * - Clasificar patrones de golpe
 * - Emitir alertas (vibración + visual) con cooldown de 4 segundos
 * - Manejar dispositivos sin soporte de vibración
 *
 * Requisitos: 1.2, 1.3, 1.4, 1.5
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyKnockPattern,
  computeSpectralCentroid,
  filterPeaksInWindow,
  isValidCentroid,
  shouldEmitAlert,
  ALERT_COOLDOWN_MS,
  type KnockPatternResult,
} from './knock-detection';

/**
 * Evento emitido cuando se detecta un patrón de golpe válido.
 */
export interface KnockPatternEvent {
  /** Timestamp de detección (ms) */
  timestamp: number;
  /** Número de picos en el patrón */
  peakCount: number;
  /** Intervalo medio entre picos (ms) */
  meanInterval: number;
  /** Desviación estándar de intervalos (ms) */
  intervalStdDev: number;
}

export interface KnockDetectorState {
  /** Indica si se está detectando activamente */
  isDetecting: boolean;
  /** Último patrón detectado, o null */
  lastPattern: KnockPatternEvent | null;
  /** Indica si hay una alerta activa visualmente */
  alertActive: boolean;
  /** Número de picos filtrados en la ventana actual */
  peaksInWindow: number;
}

export interface KnockDetectorControls {
  /** Inicia la detección de patrones */
  start: () => Promise<void>;
  /** Detiene la detección */
  stop: () => void;
  /** Registra un callback para eventos de patrón detectado */
  onPattern: (callback: (event: KnockPatternEvent) => void) => void;
}

/**
 * Opciones de configuración para el hook.
 * Permite inyectar el AnalyserNode para pruebas.
 */
export interface KnockDetectorOptions {
  /** AnalyserNode del pipeline de audio (proporcionado por useAudioEngine) */
  analyserNode?: AnalyserNode | null;
  /** Tasa de muestreo del AudioContext */
  sampleRate?: number;
  /** Si es true, el detector procesa picos que recibe externamente */
  externalPeakMode?: boolean;
}

/**
 * Hook para detección de patrones de golpe con integración al motor de audio.
 *
 * Uso típico:
 * ```tsx
 * const [audioState, audioControls] = useAudioEngine();
 * const [knockState, knockControls] = useKnockDetector({
 *   analyserNode: audioEngine.analyserNode,
 *   sampleRate: audioEngine.sampleRate,
 * });
 * ```
 */
export function useKnockDetector(
  options: KnockDetectorOptions = {},
): [KnockDetectorState, KnockDetectorControls] {
  const { analyserNode = null, sampleRate = 44100 } = options;

  const [state, setState] = useState<KnockDetectorState>({
    isDetecting: false,
    lastPattern: null,
    alertActive: false,
    peaksInWindow: 0,
  });

  // Estado interno mutable
  const peakTimestampsRef = useRef<number[]>([]);
  const lastAlertTimestampRef = useRef<number | null>(null);
  const isDetectingRef = useRef(false);
  const patternCallbackRef = useRef<((event: KnockPatternEvent) => void) | null>(null);
  const alertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Procesa un pico detectado: calcula centroide espectral, filtra, y evalúa patrón.
   * Esta función es el punto de integración con useAudioEngine.
   */
  const processPeak = useCallback(
    (timestamp: number) => {
      if (!isDetectingRef.current) return;

      // Calcular centroide espectral si hay AnalyserNode disponible
      if (analyserNode) {
        const frequencyData = new Float32Array(analyserNode.frequencyBinCount);
        analyserNode.getFloatFrequencyData(frequencyData);

        const fftSize = analyserNode.fftSize;
        const centroid = computeSpectralCentroid(frequencyData, sampleRate, fftSize);

        // Descartar picos con centroide fuera de rango 300–3500 Hz
        if (!isValidCentroid(centroid)) {
          return;
        }
      }

      // Agregar timestamp del pico filtrado a la ventana
      peakTimestampsRef.current.push(timestamp);

      // Filtrar ventana deslizante de 6 segundos
      peakTimestampsRef.current = filterPeaksInWindow(
        peakTimestampsRef.current,
        timestamp,
      );

      const peaks = peakTimestampsRef.current;

      // Actualizar conteo de picos en ventana
      setState((prev) => ({ ...prev, peaksInWindow: peaks.length }));

      // Clasificar patrón
      const result: KnockPatternResult = classifyKnockPattern(peaks);

      if (result.isPattern) {
        // Verificar cooldown
        if (!shouldEmitAlert(lastAlertTimestampRef.current, timestamp)) {
          return;
        }

        // Emitir alerta
        lastAlertTimestampRef.current = timestamp;

        const event: KnockPatternEvent = {
          timestamp,
          peakCount: result.peakCount,
          meanInterval: result.meanInterval,
          intervalStdDev: result.intervalStdDev,
        };

        // Vibración (manejar dispositivos sin soporte)
        triggerVibration();

        // Alerta visual
        setState((prev) => ({
          ...prev,
          lastPattern: event,
          alertActive: true,
        }));

        // Desactivar alerta visual después del cooldown
        if (alertTimeoutRef.current !== null) {
          clearTimeout(alertTimeoutRef.current);
        }
        alertTimeoutRef.current = setTimeout(() => {
          setState((prev) => ({ ...prev, alertActive: false }));
          alertTimeoutRef.current = null;
        }, ALERT_COOLDOWN_MS);

        // Notificar callback externo
        if (patternCallbackRef.current) {
          patternCallbackRef.current(event);
        }

        // Limpiar ventana de picos tras detección exitosa para evitar re-detecciones
        peakTimestampsRef.current = [];
        setState((prev) => ({ ...prev, peaksInWindow: 0 }));
      }
    },
    [analyserNode, sampleRate],
  );

  const start = useCallback(async () => {
    isDetectingRef.current = true;
    peakTimestampsRef.current = [];
    lastAlertTimestampRef.current = null;

    setState({
      isDetecting: true,
      lastPattern: null,
      alertActive: false,
      peaksInWindow: 0,
    });
  }, []);

  const stop = useCallback(() => {
    isDetectingRef.current = false;
    peakTimestampsRef.current = [];

    if (alertTimeoutRef.current !== null) {
      clearTimeout(alertTimeoutRef.current);
      alertTimeoutRef.current = null;
    }

    setState({
      isDetecting: false,
      lastPattern: null,
      alertActive: false,
      peaksInWindow: 0,
    });
  }, []);

  const onPattern = useCallback((callback: (event: KnockPatternEvent) => void) => {
    patternCallbackRef.current = callback;
  }, []);

  // Cleanup al desmontar
  useEffect(() => {
    return () => {
      if (alertTimeoutRef.current !== null) {
        clearTimeout(alertTimeoutRef.current);
      }
    };
  }, []);

  // Exponer processPeak para integración externa
  // El hook useAudioEngine llama a processPeak cuando detecta un pico
  useEffect(() => {
    // Almacenar en ref global accesible para el hook de audio
    (window as unknown as Record<string, unknown>).__knockDetectorProcessPeak =
      processPeak;
    return () => {
      delete (window as unknown as Record<string, unknown>).__knockDetectorProcessPeak;
    };
  }, [processPeak]);

  return [state, { start, stop, onPattern }];
}

/**
 * Intenta activar vibración del dispositivo.
 * Falla silenciosamente si el dispositivo no soporta Vibration API (Req. 1.5).
 */
function triggerVibration(): void {
  try {
    if (navigator && 'vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
  } catch {
    // Dispositivo sin soporte de vibración — solo alerta visual (Req. 1.5)
  }
}
