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
  INITIAL_NOISE_FLOOR,
  NOISE_FLOOR_ALPHA,
  updateNoiseFloor,
} from './audio-processing';

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
}

export interface AudioEngineControls {
  /** Inicia la captura y procesamiento de audio */
  start: () => Promise<void>;
  /** Detiene la captura de audio y libera recursos */
  stop: () => void;
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
  });

  // Referencias internas para el pipeline de audio
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const noiseFloorRef = useRef<number>(INITIAL_NOISE_FLOOR);
  const isListeningRef = useRef<boolean>(false);

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

    const now = Date.now();

    setState((prev) => ({
      ...prev,
      rmsLevel: rms,
      noiseFloor: newNoiseFloor,
      isPeak,
      lastPeakTimestamp: isPeak ? now : prev.lastPeakTimestamp,
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

    // Solicitar acceso al micrófono
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
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

    // Conectar pipeline: source → bandpass → analyser
    source.connect(bandpassFilter);
    bandpassFilter.connect(analyser);

    // Guardar referencias
    audioContextRef.current = audioContext;
    mediaStreamRef.current = stream;
    analyserRef.current = analyser;
    isListeningRef.current = true;
    noiseFloorRef.current = INITIAL_NOISE_FLOOR;

    setState({
      isListening: true,
      rmsLevel: 0,
      noiseFloor: INITIAL_NOISE_FLOOR,
      isPeak: false,
      lastPeakTimestamp: null,
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

    setState({
      isListening: false,
      rmsLevel: 0,
      noiseFloor: INITIAL_NOISE_FLOOR,
      isPeak: false,
      lastPeakTimestamp: null,
    });
  }, []);

  // Cleanup al desmontar el componente
  useEffect(() => {
    return () => {
      if (isListeningRef.current) {
        stop();
      }
    };
  }, [stop]);

  return [state, { start, stop }];
}
