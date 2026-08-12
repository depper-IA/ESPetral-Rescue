/**
 * Componente que muestra el estado del detector de patrones de golpe.
 *
 * Información mostrada:
 * - Cantidad de picos filtrados dentro de la ventana deslizante de 6s.
 * - Estado del detector (Detectando / Detenido).
 * - Banner pulsante de alerta cuando se detecta un patrón válido.
 * - Resumen del último patrón detectado (timestamp + confianza).
 *
 * Accesibilidad: el banner de alerta usa role="alert" para ser anunciado
 * por lectores de pantalla cuando aparece.
 *
 * Requisitos cubiertos: 1.4 (alertas visuales tras detección de patrón).
 */
import type { ReactNode } from 'react';
import type { KnockDetectorState } from './useKnockDetector';

export interface KnockStatusProps {
  knockState: KnockDetectorState;
}

/** Formatea una marca temporal (ms) como HH:MM:SS en hora local. */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function KnockStatus({ knockState }: KnockStatusProps): ReactNode {
  const last = knockState.lastPattern;
  const lastTimeText = last ? formatTime(last.timestamp) : null;
  const lastConfidenceText = last
    ? `${Math.round(last.confidence * 100)}%`
    : null;

  return (
    <div className="cali-knock-status" data-active={knockState.alertActive}>
      <p className="cali-knock-line">
        Picos en ventana (6s): {knockState.peaksInWindow}
      </p>
      <p className="cali-knock-line">
        Estado: {knockState.isDetecting ? 'Detectando' : 'Detenido'}
      </p>
      {knockState.alertActive && last && (
        <div role="alert" className="cali-knock-alert">
          ALERTA: Patrón de golpe detectado ({last.peakCount} picos, intervalo
          medio {Math.round(last.meanInterval)} ms)
        </div>
      )}
      {last && lastTimeText && lastConfidenceText && (
        <p className="cali-knock-last-pattern">
          Último patrón: {lastTimeText} (confianza {lastConfidenceText})
        </p>
      )}
    </div>
  );
}
