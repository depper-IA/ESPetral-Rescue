/**
 * Hook de React para visualizar audio en tiempo real mediante dos canvases:
 * forma de onda (dominio temporal) y espectro FFT (dominio frecuencial).
 *
 * Si analyserNode es null, el hook queda inerte (no hay datos que dibujar).
 * Usa devicePixelRatio para nitidez en pantallas retina y maneja valores
 * no finitos que getFloatFrequencyData puede devolver en silencio.
 *
 * Requisitos cubiertos: 1.6 (visualización de audio para el operador).
 */
import { useEffect, useRef, type RefObject } from 'react';

export interface AudioVisualizerRefs {
  waveformRef: RefObject<HTMLCanvasElement | null>;
  spectrumRef: RefObject<HTMLCanvasElement | null>;
}

/**
 * @param analyserNode Nodo AnalyserNode del pipeline de audio, o null.
 * @param sampleRate   Tasa de muestreo del AudioContext (referencia para
 *                     re-render cuando el contexto cambia; no se usa en el
 *                     dibujo porque el AnalyserNode conoce su contexto).
 */
export function useAudioVisualizer(
  analyserNode: AnalyserNode | null,
  sampleRate: number | null,
): AudioVisualizerRefs {
  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  const spectrumRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!analyserNode) {
      return undefined;
    }

    const waveformCanvas = waveformRef.current;
    const spectrumCanvas = spectrumRef.current;
    if (!waveformCanvas || !spectrumCanvas) {
      return undefined;
    }

    const waveformCtx = waveformCanvas.getContext('2d');
    const spectrumCtx = spectrumCanvas.getContext('2d');
    if (!waveformCtx || !spectrumCtx) {
      return undefined;
    }

    // Buffers reutilizables para evitar allocations en cada frame.
    const timeBuffer = new Float32Array(analyserNode.fftSize);
    const freqBuffer = new Float32Array(analyserNode.frequencyBinCount);

    let animFrameId: number | null = null;
    let cancelled = false;

    /** Ajusta el buffer del canvas al devicePixelRatio y resetea la transformación. */
    function resizeCanvasToCss(
      canvas: HTMLCanvasElement,
      ctx: CanvasRenderingContext2D,
    ): { width: number; height: number } {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));
      const targetWidth = cssWidth * dpr;
      const targetHeight = cssHeight * dpr;
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { width: cssWidth, height: cssHeight };
    }

    /** HSL: bajo (0) → verde (120°), alto (1) → rojo (0°). */
    function intensityColor(value: number): string {
      const clamped = Math.max(0, Math.min(1, value));
      const hue = 120 * (1 - clamped);
      return `hsl(${hue.toFixed(0)}, 90%, 55%)`;
    }

    /** Dibuja la forma de onda (dominio temporal). */
    function drawWaveform(): void {
      const { width, height } = resizeCanvasToCss(waveformCanvas!, waveformCtx!);

      waveformCtx!.fillStyle = '#0a0a0a';
      waveformCtx!.fillRect(0, 0, width, height);

      analyserNode!.getFloatTimeDomainData(timeBuffer);

      const sampleCount = timeBuffer.length;
      if (sampleCount === 0) return;

      // Ganancia de amplificación dinámica visual para evitar líneas planas en audio de baja entrada
      let maxAmp = 0.005;
      for (let i = 0; i < sampleCount; i++) {
        const absVal = Math.abs(timeBuffer[i]);
        if (absVal > maxAmp) maxAmp = absVal;
      }
      const gain = Math.min(30, Math.max(4, 0.6 / maxAmp));

      // Línea verde centrada verticalmente
      waveformCtx!.strokeStyle = '#4caf50';
      waveformCtx!.lineWidth = 1.5;
      waveformCtx!.beginPath();

      const sliceWidth = width / sampleCount;
      let x = 0;
      for (let i = 0; i < sampleCount; i++) {
        const sample = Math.max(-1, Math.min(1, timeBuffer[i] * gain));
        const y = ((sample + 1) / 2) * height;
        if (i === 0) {
          waveformCtx!.moveTo(x, y);
        } else {
          waveformCtx!.lineTo(x, y);
        }
        x += sliceWidth;
      }
      waveformCtx!.stroke();
    }

    /** Dibuja el espectro FFT como barras verticales con gradiente de color. */
    function drawSpectrum(): void {
      const { width, height } = resizeCanvasToCss(spectrumCanvas!, spectrumCtx!);

      spectrumCtx!.fillStyle = '#0a0a0a';
      spectrumCtx!.fillRect(0, 0, width, height);

      analyserNode!.getFloatFrequencyData(freqBuffer);

      const numBins = freqBuffer.length;
      if (numBins === 0) return;

      const barWidth = width / numBins;
      // getFloatFrequencyData devuelve dB en [-100, 0]; mapeamos [-90, -20] → [0, 1] para mayor sensibilidad visual
      const minDb = -90;
      const maxDb = -20;
      const dbRange = maxDb - minDb;

      for (let i = 0; i < numBins; i++) {
        const db = freqBuffer[i];
        // Tratar no-finito (por ejemplo -Infinity en silencio) como 0.
        let value = 0;
        if (Number.isFinite(db)) {
          value = (db - minDb) / dbRange;
          if (value < 0) value = 0;
          else if (value > 1) value = 1;
        }
        const barHeight = value * height;
        spectrumCtx!.fillStyle = intensityColor(value);
        spectrumCtx!.fillRect(
          i * barWidth,
          height - barHeight,
          Math.max(1, barWidth),
          barHeight,
        );
      }
    }

    /** Loop principal: dibuja ambos canvases y agenda el siguiente frame. */
    function draw(): void {
      if (cancelled) return;
      try {
        drawWaveform();
        drawSpectrum();
      } catch {
        // Ignorar errores de dibujo: el siguiente frame se seguirá intentando.
      }
      animFrameId = requestAnimationFrame(draw);
    }

    animFrameId = requestAnimationFrame(draw);

    return () => {
      cancelled = true;
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    };
  }, [analyserNode, sampleRate]);

  return { waveformRef, spectrumRef };
}
