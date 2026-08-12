/**
 * Componente que renderiza dos <canvas> apilados para visualizar el audio:
 * - Forma de onda (dominio temporal) arriba
 * - Espectro FFT (dominio frecuencial) abajo
 *
 * El dibujo se delega a useAudioVisualizer. Este componente solo define la
 * estructura visual y las clases CSS para estilo.
 *
 * Requisitos cubiertos: 1.6 (visualización de audio).
 */
import type { ReactNode } from 'react';
import { useAudioVisualizer } from './useAudioVisualizer';

export interface AudioVisualizersProps {
  analyserNode: AnalyserNode | null;
  sampleRate: number | null;
}

export function AudioVisualizers({
  analyserNode,
  sampleRate,
}: AudioVisualizersProps): ReactNode {
  const { waveformRef, spectrumRef } = useAudioVisualizer(analyserNode, sampleRate);

  return (
    <div className="cali-visualizers">
      <canvas
        ref={waveformRef}
        className="cali-waveform-canvas"
        aria-label="Forma de onda del audio en tiempo real"
      />
      <canvas
        ref={spectrumRef}
        className="cali-spectrum-canvas"
        aria-label="Espectro de frecuencias del audio en tiempo real"
      />
    </div>
  );
}
