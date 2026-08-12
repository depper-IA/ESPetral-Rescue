/**
 * ESPetral Rescue — Buscador Táctico RADAR Seeker (Componente Principal)
 *
 * Interfaz unificada de búsqueda en tiempo real para campo (móvil, tablet y PC).
 * Integra:
 *  1. Barrido radial 360° con anillos de distancia (0.5m, 1m, 2m, 3m+) y blips dinámicos
 *  2. Espectrograma Waterfall de 64 subportadoras CSI en tiempo real
 *  3. Alerta táctica integrada (Despejado / Presencia / Golpe Confirmado)
 *  4. Indicadores de telemetría acústica y fuerza de señal
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import type { ZoneAlert, RawCsiFrame } from '../sync/sync-engine';
import type { KnockDetectorState } from '../audio/useKnockDetector';

export interface RadarSeekerProps {
  /** Últimas alertas de zona con probabilidad de movimiento */
  alerts?: ZoneAlert[];
  /** Última trama CSI de 64 subportadoras recibida en tiempo real */
  rawCsiFrame?: RawCsiFrame | null;
  /** Estado del detector de golpes acústicos */
  knockState?: KnockDetectorState | null;
  /** Nombre de la zona activa seleccionada */
  activeZoneName?: string;
  /** Estado de conexión al backend */
  isConnected?: boolean;
}

export function RadarSeeker({
  alerts = [],
  rawCsiFrame = null,
  knockState = null,
  activeZoneName = 'Zona de Búsqueda 1',
  isConnected = false,
}: RadarSeekerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waterfallRef = useRef<HTMLCanvasElement | null>(null);

  // Mantiene historial de amplitudes para el waterfall canvas (filas de 64 valores)
  const [csiHistory, setCsiHistory] = useState<number[][]>([]);

  // Calcular la probabilidad más alta actual (CSI o golpe acústico)
  const currentMotionProb = useMemo(() => {
    if (alerts.length > 0) {
      return Math.max(...alerts.map((a) => a.motion_probability));
    }
    return 0;
  }, [alerts]);

  const isKnockAlert = knockState?.isKnockDetected ?? false;

  // Determinar insignia de estado global
  const statusInfo = useMemo(() => {
    if (isKnockAlert) {
      return { text: 'ALERTA DE GOLPE CONFIRMADO', color: '#ef4444', class: 'alert-knock' };
    }
    if (currentMotionProb > 0.6) {
      return { text: 'MOVIMIENTO DETECTADO', color: '#f97316', class: 'alert-motion' };
    }
    if (currentMotionProb > 0.3) {
      return { text: 'PRESENCIA DETECTADA', color: '#eab308', class: 'alert-presence' };
    }
    return { text: 'ÁREA DESPEJADA', color: '#10b981', class: 'alert-clear' };
  }, [currentMotionProb, isKnockAlert]);

  // Actualizar historial CSI para el espectrograma
  useEffect(() => {
    if (rawCsiFrame && Array.isArray(rawCsiFrame.subcarrier_amplitudes)) {
      setCsiHistory((prev) => {
        const next = [rawCsiFrame.subcarrier_amplitudes, ...prev];
        return next.slice(0, 150); // Mantiene 150 columnas de historial
      });
    }
  }, [rawCsiFrame]);

  // Renderizar Barrido Radial 360° en Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let angle = 0;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(cx, cy) - 16;

      ctx.clearRect(0, 0, w, h);

      // Fondo del radar táctico
      ctx.fillStyle = '#090d16';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      // Anillos concéntricos de proximidad (0.5m, 1m, 2m, 3m+)
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.5;
      [0.25, 0.5, 0.75, 1.0].forEach((ratio, idx) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * ratio, 0, Math.PI * 2);
        ctx.stroke();

        // Etiquetas de distancia
        ctx.fillStyle = '#64748b';
        ctx.font = '10px monospace';
        const labels = ['0.5m', '1.0m', '2.0m', '3.0m+'];
        ctx.fillText(labels[idx], cx + 4, cy - radius * ratio + 12);
      });

      // Ejes en cruz (N, S, E, O)
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      // Línea de barrido animado 360°
      angle = (angle + 0.03) % (Math.PI * 2);
      const sweepX = cx + Math.cos(angle) * radius;
      const sweepY = cy + Math.sin(angle) * radius;

      // Abanico difuminado del haz de radar
      const grad = ctx.createConicGradient(angle - 0.5, cx, cy);
      grad.addColorStop(0, 'rgba(233, 69, 96, 0.25)');
      grad.addColorStop(0.1, 'rgba(233, 69, 96, 0.05)');
      grad.addColorStop(1, 'transparent');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle - 0.5, angle);
      ctx.closePath();
      ctx.fill();

      // Línea frontal de barrido
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sweepX, sweepY);
      ctx.stroke();

      // Dibuja Blips dinámicos de objetivo si hay movimiento o golpe
      if (currentMotionProb > 0.2 || isKnockAlert) {
        const blipDist = radius * (1 - Math.min(1, currentMotionProb * 0.8));
        const blipAngle = angle - 0.2; // Ligeramente detrás de la línea de barrido
        const bx = cx + Math.cos(blipAngle) * blipDist;
        const by = cy + Math.sin(blipAngle) * blipDist;

        // Anillo pulsante alrededor del objetivo
        ctx.fillStyle = isKnockAlert ? 'rgba(239, 68, 68, 0.8)' : 'rgba(249, 115, 22, 0.8)';
        ctx.beginPath();
        ctx.arc(bx, by, isKnockAlert ? 10 : 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(bx, by, isKnockAlert ? 16 : 12, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(
          isKnockAlert ? '¡GOLPE!' : `TARGET ${(currentMotionProb * 100).toFixed(0)}%`,
          bx + 12,
          by - 4
        );
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [currentMotionProb, isKnockAlert]);

  // Renderizar Espectrograma Waterfall de 64 Subportadoras
  useEffect(() => {
    const canvas = waterfallRef.current;
    if (!canvas || csiHistory.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const numCols = csiHistory.length;
    const colWidth = Math.max(2, w / 150);

    // Dibujar cada columna del historial (de derecha a izquierda)
    csiHistory.forEach((amps, colIdx) => {
      const x = w - (colIdx + 1) * colWidth;

      for (let sc = 0; sc < 64 && sc < amps.length; sc++) {
        const val = Math.min(100, Math.max(0, amps[sc] || 0));
        let r = 0, g = 0, b = 0;

        if (val < 25) {
          b = Math.floor(255 * (val / 25));
        } else if (val < 50) {
          g = Math.floor(255 * ((val - 25) / 25));
          b = 255 - g;
        } else if (val < 75) {
          r = Math.floor(255 * ((val - 50) / 25));
          g = 255;
        } else {
          r = 255;
          g = Math.floor(255 * (1 - (val - 75) / 25));
        }

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, sc * (h / 64), colWidth, h / 64 + 0.5);
      }
    });
  }, [csiHistory]);

  return (
    <div style={{ padding: '16px', color: '#f8fafc', background: '#0e1116', borderRadius: '12px', border: '1px solid #1e293b' }}>
      {/* Encabezado Táctico */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: '#f8fafc', letterSpacing: '0.5px' }}>
            🎯 BUSCADOR TÁCTICO RADAR
          </h2>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{activeZoneName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '0.75rem',
              fontWeight: 800,
              background: statusInfo.color,
              color: '#000',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              boxShadow: `0 0 12px ${statusInfo.color}66`,
            }}
          >
            {statusInfo.text}
          </span>
          <span style={{ fontSize: '0.7rem', color: isConnected ? '#10b981' : '#ef4444', fontWeight: 600 }}>
            {isConnected ? '● ONLINE' : '○ OFFLINE'}
          </span>
        </div>
      </div>

      {/* Canvas del Barrido Radial RADAR 360° */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={320}
          height={320}
          style={{
            background: '#090d16',
            borderRadius: '50%',
            border: '2px solid #1e293b',
            boxShadow: '0 0 20px rgba(0,0,0,0.8)',
            maxWidth: '100%',
            height: 'auto',
          }}
        />
      </div>

      {/* Métricas de Señal en Tiempo Real */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', margin: '12px 0' }}>
        <div style={{ background: '#161b22', padding: '8px 12px', borderRadius: '8px', border: '1px solid #21262d', textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: '#8b949e' }}>PROBABILIDAD CSI</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: currentMotionProb > 0.5 ? '#f97316' : '#10b981' }}>
            {(currentMotionProb * 100).toFixed(0)}%
          </div>
        </div>

        <div style={{ background: '#161b22', padding: '8px 12px', borderRadius: '8px', border: '1px solid #21262d', textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: '#8b949e' }}>ACÚSTICA (GOLPE)</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: isKnockAlert ? '#ef4444' : '#10b981' }}>
            {isKnockAlert ? 'ALERTA' : '0%'}
          </div>
        </div>

        <div style={{ background: '#161b22', padding: '8px 12px', borderRadius: '8px', border: '1px solid #21262d', textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: '#8b949e' }}>SUBPORTADORAS</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#38bdf8' }}>
            {rawCsiFrame?.subcarrier_amplitudes?.length ?? 64}
          </div>
        </div>
      </div>

      {/* Espectrograma Waterfall CSI 64 Subportadoras */}
      <div style={{ marginTop: '12px', background: '#161b22', padding: '10px', borderRadius: '8px', border: '1px solid #21262d' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#8b949e', marginBottom: '6px' }}>
          <span style={{ fontWeight: 600 }}>ESPECTROGRAMA CSI (64 CANALES)</span>
          <span>TIEMPO RECIENTE ➔</span>
        </div>
        <canvas
          ref={waterfallRef}
          width={300}
          height={96}
          style={{
            width: '100%',
            height: '96px',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '4px',
            display: 'block',
            imageRendering: 'pixelated',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#6e7681', marginTop: '4px' }}>
          <span>Subportadora 0 (2.4GHz baja)</span>
          <span>Subportadora 63 (2.4GHz alta)</span>
        </div>
      </div>
    </div>
  );
}
