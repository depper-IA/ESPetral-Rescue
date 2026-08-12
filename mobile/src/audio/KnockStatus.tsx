/**
 * Componentes que muestran el estado del detector de patrones de golpe.
 *
 * `KnockStatus`: información no crítica, mostrada en su lugar habitual
 * dentro de AudioSection (no sticky).
 * - Cantidad de picos filtrados dentro de la ventana deslizante de 6s.
 * - Estado del detector (Detectando / Detenido).
 * - Resumen del último patrón detectado (timestamp + confianza).
 *
 * `KnockAlertBanner`: banner crítico de alerta, fijo en la parte superior
 * del viewport (ver App.tsx). Se separó del flujo normal de AudioSection
 * porque si el usuario hace scroll fuera de esa sección (ej. para ver el
 * mapa), una alerta no-sticky deja de ser visible — inaceptable para una
 * señal de "posible víctima detectada". Fondo sólido (no rgba compuesto)
 * para garantizar contraste >= 4.5:1 con texto blanco.
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
      {last && lastTimeText && lastConfidenceText && (
        <p className="cali-knock-last-pattern">
          Último patrón: {lastTimeText} (confianza {lastConfidenceText})
        </p>
      )}
    </div>
  );
}

/**
 * Banner crítico de alerta de golpe, fijo en la parte superior del
 * viewport. Renderizado a nivel de App (no dentro de AudioSection) para
 * que permanezca visible sin importar hacia dónde haga scroll el usuario.
 */
export function KnockAlertBanner({ knockState }: KnockStatusProps): ReactNode {
  if (!knockState.alertActive) return null;
  const last = knockState.lastPattern;

  return (
    <div role="alert" className="cali-knock-alert-banner">
      ALERTA: Patrón de golpes detectado
      {last && (
        <div className="cali-knock-alert-banner-detail">
          {last.peakCount} picos, intervalo medio {Math.round(last.meanInterval)} ms
        </div>
      )}
    </div>
  );
}
