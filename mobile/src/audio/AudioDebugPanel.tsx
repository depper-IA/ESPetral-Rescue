/**
 * Panel de debug acustico para el modulo de audio.
 *
 * Muestra en tiempo real:
 *  - Nivel RMS actual y piso de ruido
 *  - Umbral dinamico de deteccion de picos
 *  - Centroide espectral (Hz) del frame actual
 *  - Conteo de picos detectados, filtrados por Hz, y dentro de la ventana
 *  - Estado de la alerta activa
 *
 * Pensado como herramienta de campo para que el operador del backend
 * diagnostique la sensibilidad del microfono y los parametros del
 * detector de patrones de golpe sin tener que abrir DevTools.
 */
import type { ReactNode } from 'react';

export interface AudioDebugPanelProps {
  /** Nivel RMS del frame actual (0.0 a 1.0) */
  rmsLevel: number;
  /** Piso de ruido suavizado */
  noiseFloor: number;
  /** Umbral dinamico de pico (= max(3.5 * noiseFloor, 0.06)) */
  currentThreshold: number;
  /** Centroide espectral (Hz) del frame actual, null si no hay datos */
  currentCentroid: number | null;
  /** Picos detectados desde que se inicio la escucha */
  peaksDetected: number;
  /** Picos descartados por estar fuera del rango 300-3500 Hz */
  peaksFilteredByCentroid: number;
  /** Picos dentro de la ventana deslizante de 6 s */
  peaksInWindow: number;
  /** true cuando hay una alerta visual activa */
  alertActive: boolean;
}

/** Formatea un numero con 2 decimales. */
function fmt(value: number): string {
  return value.toFixed(2);
}

export function AudioDebugPanel({
  rmsLevel,
  noiseFloor,
  currentThreshold,
  currentCentroid,
  peaksDetected,
  peaksFilteredByCentroid,
  peaksInWindow,
  alertActive,
}: AudioDebugPanelProps): ReactNode {
  const centroidText = currentCentroid === null ? '--' : fmt(currentCentroid);

  return (
    <div className="cali-debug-panel" data-active={alertActive}>
      <div className="cali-debug-panel-title">Debug acustico</div>
      <div className="cali-debug-row">
        <span>RMS actual</span>
        <span>{fmt(rmsLevel)}</span>
      </div>
      <div className="cali-debug-row">
        <span>Piso de ruido</span>
        <span>{fmt(noiseFloor)}</span>
      </div>
      <div className="cali-debug-row">
        <span>Umbral (3.5x)</span>
        <span>{fmt(currentThreshold)}</span>
      </div>
      <div className="cali-debug-row">
        <span>Centroide (Hz)</span>
        <span>{centroidText}</span>
      </div>
      <div className="cali-debug-divider" />
      <div className="cali-debug-row">
        <span>Picos detectados</span>
        <span>{peaksDetected}</span>
      </div>
      <div className="cali-debug-row">
        <span>Filtrados (Hz)</span>
        <span>{peaksFilteredByCentroid}</span>
      </div>
      <div className="cali-debug-row">
        <span>En ventana (6s)</span>
        <span>{peaksInWindow}</span>
      </div>
      <div className="cali-debug-row">
        <span>Alerta activa</span>
        <span>{alertActive ? 'Si' : 'No'}</span>
      </div>
    </div>
  );
}
