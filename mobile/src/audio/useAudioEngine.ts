/**
 * Hook de React para el motor de audio con Web Audio API.
 * Pipeline: getUserMedia → BiquadFilter (bandpass 200–4000Hz) → AnalyserNode (fftSize=2048)
 *
 * Requisitos: 1.1, 1.6, 1.7
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyPeak,
  computeRms,
  computeRmsPercentage,
  estimateStereoDoa,
  INITIAL_NOISE_FLOOR,
  NOISE_FLOOR_ALPHA,
  PEAK_ABSOLUTE_THRESHOLD,
  PEAK_NOISE_MULTIPLIER,
  updateNoiseFloor,
} from './audio-processing';
import { computeSpectralCentroid } from './knock-detection';

/** Umbral inicial derivado del piso de ruido inicial. */
function initialThreshold(): number {
  return Math.max(PEAK_NOISE_MULTIPLIER * INITIAL_NOISE_FLOOR, PEAK_ABSOLUTE_THRESHOLD);
}

export interface AudioEngineState {
  /** Indica si el motor de audio está activo */
  isListening: boolean;
  /** Nivel RMS actual (0.0 a 1.0) */
  rmsLevel: number;
  /** Piso de ruido actual */
  noiseFloor: number;
  /** Indica si el frame actual es un pico */
  isPeak: boolean;
  /** Marca temporal del último pico detectado */
  lastPeakTimestamp: number | null;
  /**
   * AnalyserNode del pipeline de audio, expuesto para integración con
   * useKnockDetector (filtrado por centroide espectral). null si el motor
   * no está activo.
   */
  analyserNode: AnalyserNode | null;
  /** Tasa de muestreo del AudioContext activo, o null si no está activo */
  sampleRate: number | null;
  /** Último centroide espectral calculado (Hz), null si aún no se calculó */
  currentCentroid: number | null;
  /** Umbral dinámico de pico (= max(PEAK_NOISE_MULTIPLIER * noiseFloor, PEAK_ABSOLUTE_THRESHOLD)) */
  currentThreshold: number;
  /** Total de picos detectados desde que se inició la escucha */
  peaksDetected: number;
  /** Ángulo estimado de dirección de arribo en grados (-90° Izq a +90° Der), null si es mono */
  directionAngle: number | null;
  /** Confianza de la estimación de dirección (0.0 a 1.0) */
  directionConfidence: number;
}

export interface AudioEngineControls {
  /** Inicia la captura y procesamiento de audio */
  start: () => Promise<void>;
  /** Detiene la captura de audio y libera recursos */
  stop: () => void;
  /**
   * Registra (o remueve, pasando null) un callback invocado en cada pico
   * detectado. Punto de integración con useKnockDetector.
   */
  onPeak: (callback: ((timestamp: number) => void) | null) => void;
}

/**
 * Hook que encapsula el pipeline completo de Web Audio API para detección acústica.
 *
 * Cadena de procesamiento:
 * getUserMedia → BiquadFilter (bandpass 200–4000Hz) → AnalyserNode (fftSize=2048)
 *
 * Actualiza el medidor RMS a ≥20 fps usando requestAnimationFrame.
 */
export function useAudioEngine(): [AudioEngineState, AudioEngineControls] {
  const [state, setState] = useState<AudioEngineState>({
    isListening: false,
    rmsLevel: 0,
    noiseFloor: INITIAL_NOISE_FLOOR,
    isPeak: false,
    lastPeakTimestamp: null,
    analyserNode: null,
    sampleRate: null,
    currentCentroid: null,
    currentThreshold: initialThreshold(),
    peaksDetected: 0,
    directionAngle: null,
    directionConfidence: 0,
  });

  // Referencias internas para el pipeline de audio
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const leftAnalyserRef = useRef<AnalyserNode | null>(null);
  const rightAnalyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const noiseFloorRef = useRef<number>(INITIAL_NOISE_FLOOR);
  const isListeningRef = useRef<boolean>(false);
  const peaksDetectedRef = useRef<number>(0);

  // Callback de análisis llamado cada frame (≥20 fps con requestAnimationFrame)
  const onPeakCallbackRef = useRef<((timestamp: number) => void) | null>(null);

  const processAudioFrame = useCallback(() => {
    if (!isListeningRef.current || !analyserRef.current) return;

    const analyser = analyserRef.current;
    const timeDomainData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeDomainData);

    // Calcular RMS
    const rms = computeRms(timeDomainData);

    // Actualizar piso de ruido con suavizado exponencial
    const newNoiseFloor = updateNoiseFloor(
      rms,
      noiseFloorRef.current,
      NOISE_FLOOR_ALPHA,
    );
    noiseFloorRef.current = newNoiseFloor;

    // Clasificar si es un pico
    const isPeak = classifyPeak(rms, newNoiseFloor);

    // Calcular centroide espectral y umbral dinámico para el panel de debug
    const frequencyData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(frequencyData);
    const centroid = computeSpectralCentroid(
      frequencyData,
      audioContextRef.current?.sampleRate ?? 44100,
      analyser.fftSize,
    );
    const threshold = Math.max(
      PEAK_NOISE_MULTIPLIER * newNoiseFloor,
      PEAK_ABSOLUTE_THRESHOLD,
    );

    const now = Date.now();

    if (isPeak) {
      peaksDetectedRef.current += 1;
    }

    // Estimar dirección de arribo estéreo (DoA) si hay 2 canales
    let directionAngle: number | null = null;
    let directionConfidence = 0;

    if (leftAnalyserRef.current && rightAnalyserRef.current) {
      const leftTimeData = new Float32Array(leftAnalyserRef.current.fftSize);
      const rightTimeData = new Float32Array(rightAnalyserRef.current.fftSize);
      leftAnalyserRef.current.getFloatTimeDomainData(leftTimeData);
      rightAnalyserRef.current.getFloatTimeDomainData(rightTimeData);

      const doa = estimateStereoDoa(
        leftTimeData,
        rightTimeData,
        audioContextRef.current?.sampleRate ?? 44100,
        0.025, // Distancia entre cápsulas estéreo (Boya PM700)
      );
      if (doa.confidence > 0.25) {
        directionAngle = doa.angleDegrees;
        directionConfidence = doa.confidence;
      }
    }

    setState((prev) => ({
      ...prev,
      rmsLevel: computeRmsPercentage(rms),
      noiseFloor: newNoiseFloor,
      isPeak,
      lastPeakTimestamp: isPeak ? now : prev.lastPeakTimestamp,
      currentCentroid: centroid,
      currentThreshold: threshold,
      peaksDetected: peaksDetectedRef.current,
      directionAngle: directionAngle ?? prev.directionAngle,
      directionConfidence,
    }));

    // Notificar picos al callback externo
    if (isPeak && onPeakCallbackRef.current) {
      onPeakCallbackRef.current(now);
    }

    // Programar próximo frame (requestAnimationFrame garantiza ≥20 fps en la mayoría de dispositivos)
    animFrameRef.current = requestAnimationFrame(processAudioFrame);
  }, []);

  const start = useCallback(async () => {
    if (isListeningRef.current) return;

    // Solicitar acceso al micrófono (preferir 2 canales estéreo para Boya PM700)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // Crear contexto de audio
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);

    // Filtro bandpass 200–4000 Hz (Requisito 1.1)
    const bandpassFilter = audioContext.createBiquadFilter();
    bandpassFilter.type = 'bandpass';
    // Frecuencia central geométrica: sqrt(200 * 4000) ≈ 894 Hz
    bandpassFilter.frequency.value = Math.sqrt(200 * 4000);
    // Q = fc / bandwidth = 894 / 3800 ≈ 0.235
    // BiquadFilter usa Q de forma diferente: Q = fc / (f2 - f1)
    bandpassFilter.Q.value = Math.sqrt(200 * 4000) / (4000 - 200);

    // AnalyserNode con fftSize=2048
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;

    // Conectar pipeline principal: source → bandpass → analyser
    source.connect(bandpassFilter);
    bandpassFilter.connect(analyser);

    // Conectar analizadores estéreo para DoA si la fuente tiene 2 canales
    let leftAnalyser: AnalyserNode | null = null;
    let rightAnalyser: AnalyserNode | null = null;

    if (source.channelCount >= 2) {
      const splitter = audioContext.createChannelSplitter(2);
      leftAnalyser = audioContext.createAnalyser();
      leftAnalyser.fftSize = 2048;
      rightAnalyser = audioContext.createAnalyser();
      rightAnalyser.fftSize = 2048;

      source.connect(splitter);
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, 1);
    }

    // Guardar referencias
    audioContextRef.current = audioContext;
    mediaStreamRef.current = stream;
    analyserRef.current = analyser;
    leftAnalyserRef.current = leftAnalyser;
    rightAnalyserRef.current = rightAnalyser;
    isListeningRef.current = true;
    noiseFloorRef.current = INITIAL_NOISE_FLOOR;
    peaksDetectedRef.current = 0;

    setState({
      isListening: true,
      rmsLevel: 0,
      noiseFloor: INITIAL_NOISE_FLOOR,
      isPeak: false,
      lastPeakTimestamp: null,
      analyserNode: analyser,
      sampleRate: audioContext.sampleRate,
      currentCentroid: null,
      currentThreshold: initialThreshold(),
      peaksDetected: 0,
      directionAngle: null,
      directionConfidence: 0,
    });

    // Iniciar loop de procesamiento
    animFrameRef.current = requestAnimationFrame(processAudioFrame);
  }, [processAudioFrame]);

  const stop = useCallback(() => {
    isListeningRef.current = false;

    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    analyserRef.current = null;
    leftAnalyserRef.current = null;
    rightAnalyserRef.current = null;
    peaksDetectedRef.current = 0;

    setState({
      isListening: false,
      rmsLevel: 0,
      noiseFloor: INITIAL_NOISE_FLOOR,
      isPeak: false,
      lastPeakTimestamp: null,
      analyserNode: null,
      sampleRate: null,
      currentCentroid: null,
      currentThreshold: initialThreshold(),
      peaksDetected: 0,
      directionAngle: null,
      directionConfidence: 0,
    });
  }, []);

  // Registra o remueve (con null) el callback invocado en cada pico detectado.
  // Punto de integración con useKnockDetector — reemplaza el acoplamiento
  // implícito previo (ver historial de App.tsx).
  const onPeak = useCallback((callback: ((timestamp: number) => void) | null) => {
    onPeakCallbackRef.current = callback;
  }, []);

  // Cleanup al desmontar el componente
  useEffect(() => {
    return () => {
      if (isListeningRef.current) {
        stop();
      }
    };
  }, [stop]);

  return [state, { start, stop, onPeak }];
}
