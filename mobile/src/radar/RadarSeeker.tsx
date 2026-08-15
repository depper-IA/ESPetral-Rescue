/**
 * ESPetral Rescue — Buscador Táctico RADAR Seeker (Componente Principal)
 *
 * Interfaz unificada de búsqueda en tiempo real para campo (móvil, tablet y PC).
 * Integra:
 *  1. Indicador de tendencia de proximidad por RSSI real (nodo único, sin
 *     posición espacial fabricada — ver Requisito 19)
 *  2. Espectrograma Waterfall de 64 subportadoras CSI en tiempo real
 *  3. Alerta táctica integrada (Despejado / Presencia / Golpe Confirmado)
 *  4. Indicadores de telemetría acústica y fuerza de señal
 *
 * Requisito 19 (Single-Node Signal Proximity Indicator): con un único nodo
 * ESP32 desplegado no existe dato de distancia real. El barrido radial 360°
 * con anillos de distancia y blips posicionales que existía antes en este
 * componente fabricaba una posición a partir de motion_probability — se
 * eliminó por completo (Requisitos 19.4, 19.5). En su lugar se muestra una
 * tendencia (acercándose / alejándose / estable) derivada de una media móvil
 * exponencial (EMA) sobre el RSSI real reportado por el nodo.
 *
 * Eliminación del panel de "triangulación" (dato fabricado): este componente
 * tenía además un bloque "MAPA DE TRIANGULACIÓN Y ESTIMACIÓN DE DISTANCIA"
 * que convertía RSSI a metros vía `Math.pow(10, (-45 - rssi) / 32)`. Se
 * eliminó por completo, por dos razones independientes y cada una
 * suficiente por sí sola:
 *  1. RSSI mide la potencia de la señal de radio entre DOS RADIOS (el nodo
 *     ESP32 y el punto de acceso WiFi con el que negocia). Una persona
 *     atrapada bajo escombros no emite WiFi. La "distancia" calculada era
 *     la distancia estimada al access point, no a una víctima — mostrar
 *     ese número junto a un ícono de rescate induce a cavar en el lugar
 *     equivocado.
 *  2. Aunque el dato de radio fuera relevante, lo que hacía el código no
 *     era triangulación: triangular con múltiples nodos produce un punto
 *     (intersección de círculos/rectas), no un radio. Y el cálculo del
 *     "radio estimado" ni siquiera combinaba las distancias de los nodos
 *     mostrados — recalculaba un único valor global a partir de
 *     `proximity.currentRssi`, ignorando por completo los demás nodos.
 * En su lugar, el panel que ocupaba ese espacio ahora es el detector de
 * patrón respiratorio (ver `breathing-detector.ts`): la única señal en este
 * sistema que sí puede indicar honestamente "hay una persona" a partir de
 * CSI, porque busca periodicidad en 0.2-0.5 Hz (12-30 resp/min), no una
 * posición fabricada.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import type { ZoneAlert, RawCsiFrame } from '../sync/sync-engine';
import type { KnockDetectorState } from '../audio/useKnockDetector';
import { analyzeBreathing, type BreathingResult } from './breathing-detector';

export interface RadarSeekerProps {
  /** Últimas alertas de zona con probabilidad de movimiento */
  alerts?: readonly ZoneAlert[];
  /** Última trama CSI de 64 subportadoras recibida en tiempo real */
  rawCsiFrame?: RawCsiFrame | null;
  /** Estado del detector de golpes acústicos */
  knockState?: KnockDetectorState | null;
  /** Nombre de la zona activa seleccionada */
  activeZoneName?: string;
  /** Estado de conexión al backend */
  isConnected?: boolean;
  /** Estado de captura del micrófono */
  isAudioListening?: boolean;
  /** Callback para activar o desactivar la escucha del micrófono */
  onToggleAudio?: () => void;
  /** Nivel de señal RMS del micrófono en tiempo real (0.0 - 1.0) */
  rmsLevel?: number;
  /** Error de inicio del micrófono (si ocurrió uno) */
  startError?: string | null;
  /** Ángulo estimado de dirección de arribo en grados (-90° Izq a +90° Der) */
  directionAngle?: number | null;
}

// --- Tendencia de proximidad por RSSI (Requisito 19) ---

/** Clasificación de tendencia derivada de la EMA de RSSI. */
export type ProximityTrend = 'approaching' | 'receding' | 'stable' | 'no_data';

export interface ProximityTrendResult {
  trend: ProximityTrend;
  /** Última lectura de RSSI cruda (dBm), o null si no hay datos */
  currentRssi: number | null;
}

/** Factor de suavizado de la media móvil exponencial. */
const EMA_ALPHA = 0.3;

/**
 * Banda muerta en dB: cambios de EMA por debajo de este umbral se
 * consideran ruido y se clasifican como "estable", no como tendencia real.
 */
const DEAD_BAND_DB = 1.5;

/**
 * Calcula la tendencia de proximidad a partir de un historial de RSSI en
 * orden cronológico (más antiguo primero, más reciente al final).
 *
 * RSSI es negativo en dBm: un valor menos negativo (ej. -50 vs -80)
 * significa señal más fuerte, es decir, más cerca del nodo.
 *
 * Algoritmo: se calcula la serie completa de EMA (alpha=0.3) sobre el
 * historial, y se compara el último valor de la serie contra el
 * penúltimo. Si la diferencia supera la banda muerta (±1.5 dB) hacia
 * arriba, la tendencia es "approaching"; hacia abajo, "receding"; si no,
 * "stable". Con menos de 2 lecturas no hay base de comparación y se
 * reporta "stable". Con 0 lecturas se reporta "no_data" explícito — nunca
 * se fabrica un valor por defecto.
 */
export function computeProximityTrend(
  rssiHistoryChronological: readonly number[],
): ProximityTrendResult {
  if (rssiHistoryChronological.length === 0) {
    return { trend: 'no_data', currentRssi: null };
  }

  const emaSeries: number[] = [rssiHistoryChronological[0]];
  for (let i = 1; i < rssiHistoryChronological.length; i++) {
    emaSeries.push(EMA_ALPHA * rssiHistoryChronological[i] + (1 - EMA_ALPHA) * emaSeries[i - 1]);
  }

  const currentRssi = rssiHistoryChronological[rssiHistoryChronological.length - 1];

  if (emaSeries.length < 2) {
    return { trend: 'stable', currentRssi };
  }

  const currentEma = emaSeries[emaSeries.length - 1];
  const previousEma = emaSeries[emaSeries.length - 2];
  const delta = currentEma - previousEma;

  if (delta > DEAD_BAND_DB) {
    return { trend: 'approaching', currentRssi };
  }
  if (delta < -DEAD_BAND_DB) {
    return { trend: 'receding', currentRssi };
  }
  return { trend: 'stable', currentRssi };
}

/** Cantidad máxima de lecturas de RSSI consideradas para la tendencia (historial corto). */
const RSSI_HISTORY_WINDOW = 20;

/**
 * Ventana (ms) sin recibir lecturas tras la cual un nodo deja de contarse
 * como activo.
 *
 * Por qué existe: el buffer de alertas conserva las últimas 50 lecturas sin
 * expirarlas, así que un nodo que cambia de identidad (por ejemplo al
 * grabarle un `node_id` nuevo en NVS) seguía apareciendo bajo su ID viejo Y
 * el nuevo, mostrando dos nodos donde hay una sola placa. En campo eso se
 * lee como cobertura duplicada que no existe. Los nodos publican cada ~2 s;
 * 15 s tolera varias pérdidas seguidas sin marcar un nodo vivo como caído.
 */
const NODE_ACTIVE_WINDOW_MS = 15_000;

/** Cadencia del reloj interno que expira nodos sin tráfico reciente. */
const ACTIVE_NODES_TICK_MS = 3_000;

/** Presentación visual por tipo de tendencia (paleta oscura consistente con el resto del componente). */
const TREND_DISPLAY: Record<ProximityTrend, { label: string; color: string }> = {
  approaching: { label: 'ACERCÁNDOSE', color: '#10b981' },
  receding: { label: 'ALEJÁNDOSE', color: '#ef4444' },
  stable: { label: 'ESTABLE', color: '#8b949e' },
  no_data: { label: 'SIN DATOS DE SEÑAL', color: '#8b949e' },
};

// --- Detección de patrón respiratorio (buffer + throttle de análisis) ---

/** Máxima antigüedad de frames retenidos para el análisis de respiración (90s). */
const BREATHING_BUFFER_MAX_MS = 90_000;

/** El análisis (FFT por subportadora) corre como máximo cada 3s, no en cada frame. */
const BREATHING_ANALYSIS_INTERVAL_MS = 3_000;

/** Veredicto de respiración asociado a un nodo concreto. */
export interface BreathingByNode {
  nodeId: string;
  result: BreathingResult;
}

export function RadarSeeker({
  alerts = [],
  rawCsiFrame = null,
  knockState = null,
  activeZoneName = 'Zona de Búsqueda 1',
  isConnected = false,
  isAudioListening = false,
  onToggleAudio,
  rmsLevel = 0,
  startError = null,
  directionAngle = null,
}: RadarSeekerProps) {
  const waterfallRef = useRef<HTMLCanvasElement | null>(null);

  /*
   * Reloj interno: sin él, un nodo que deja de transmitir permanecería
   * listado como activo indefinidamente, porque sin alertas nuevas no hay
   * re-render que revalúe su antigüedad.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ACTIVE_NODES_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Mantiene historial de amplitudes para el waterfall canvas (filas de 64 valores)
  const [csiHistory, setCsiHistory] = useState<number[][]>([]);

  // Un buffer de frames CSI por nodo (ver comentario en el efecto que los
  // alimenta), y throttle del último análisis ejecutado.
  const breathingBuffersRef = useRef<
    Map<string, { amplitudes: readonly number[]; timestampMs: number }[]>
  >(new Map());
  const lastBreathingAnalysisRef = useRef(0);
  const [breathingByNode, setBreathingByNode] = useState<BreathingByNode[]>([]);

  // Calcular la probabilidad más alta actual (CSI o golpe acústico)
  const currentMotionProb = useMemo(() => {
    if (alerts.length > 0) {
      return Math.max(...alerts.map((a) => a.motion_probability));
    }
    return 0;
  }, [alerts]);

  const isKnockAlert = knockState?.alertActive ?? false;

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

  // Historial corto de RSSI en orden cronológico (más antiguo primero) a partir
  // de las alertas recibidas. `alerts` llega ordenado con la más reciente primero
  // (ver SyncEngine.addAlert: unshift), por lo que se toman las N más recientes
  // y se invierten para que la EMA se calcule en orden temporal correcto.
  const rssiHistoryChronological = useMemo(() => {
    const withRssi = alerts.filter(
      (a): a is ZoneAlert & { rssi: number } => typeof a.rssi === 'number',
    );
    return withRssi
      .slice(0, RSSI_HISTORY_WINDOW)
      .map((a) => a.rssi)
      .reverse();
  }, [alerts]);

  const proximity = useMemo(
    () => computeProximityTrend(rssiHistoryChronological),
    [rssiHistoryChronological],
  );
  const proximityDisplay = TREND_DISPLAY[proximity.trend];

  // Extraer nodos activos únicos recibidos en las alertas
  const activeNodes = useMemo(() => {
    const cutoff = nowMs - NODE_ACTIVE_WINDOW_MS;
    const nodeMap = new Map<string, { node_id: string; rssi: number | null; motion: number }>();

    /*
     * `alerts` llega con la más reciente primero, así que la primera
     * aparición de cada node_id es su última lectura.
     */
    alerts.forEach((alert) => {
      if (typeof alert.node_id !== 'string') return;
      if (alert.receivedAt < cutoff) return;
      if (nodeMap.has(alert.node_id)) return;
      nodeMap.set(alert.node_id, {
        node_id: alert.node_id,
        rssi: typeof alert.rssi === 'number' ? alert.rssi : null,
        motion: alert.motion_probability,
      });
    });

    return Array.from(nodeMap.values());
  }, [alerts, nowMs]);

  // Actualizar historial CSI para el espectrograma
  useEffect(() => {
    if (rawCsiFrame && Array.isArray(rawCsiFrame.subcarrier_amplitudes)) {
      setCsiHistory((prev) => {
        const next = [rawCsiFrame.subcarrier_amplitudes, ...prev];
        return next.slice(0, 150); // Mantiene 150 columnas de historial
      });
    }
  }, [rawCsiFrame]);

  // Acumular frames CSI para el detector de patrón respiratorio y ejecutar
  // el análisis cada ~3s (no en cada frame — el análisis hace una FFT por
  // subportadora y es costoso para correr a la tasa de llegada de frames,
  // ~5 Hz). El buffer se acota a BREATHING_BUFFER_MAX_MS para no crecer sin
  // límite en sesiones largas.
  useEffect(() => {
    if (!rawCsiFrame || !Array.isArray(rawCsiFrame.subcarrier_amplitudes)) return;

    /*
     * Se usa la hora de llegada del cliente, NO `rawCsiFrame.timestamp`: el
     * ESP32 no tiene RTC y envía su tiempo desde el arranque (se observan
     * valores como "1970-01-01T00:00:52Z"). Con dos nodos de uptime distinto
     * esos timestamps difieren en minutos, y al mezclarlos la ventana
     * aparentaba ~20 min con una tasa de muestreo irrisoria, dejando el
     * análisis clavado en "datos insuficientes" para siempre.
     */
    const nowMsLocal = Date.now();
    const frame = {
      amplitudes: rawCsiFrame.subcarrier_amplitudes,
      timestampMs: nowMsLocal,
    };

    /*
     * Buffer SEPARADO por nodo: cada ESP32 observa un camino de señal
     * distinto, así que mezclar sus tramas en un mismo análisis no tiene
     * sentido físico. Analizar por nodo es además lo que aporta valor en
     * campo — "Bebe detecta respiración y Mamá no" acota el área de búsqueda.
     */
    const nodeId = rawCsiFrame.node_id || 'desconocido';
    const buffers = breathingBuffersRef.current;
    let buffer = buffers.get(nodeId);
    if (!buffer) {
      buffer = [];
      buffers.set(nodeId, buffer);
    }

    buffer.push(frame);
    const cutoff = nowMsLocal - BREATHING_BUFFER_MAX_MS;
    while (buffer.length > 0 && buffer[0].timestampMs < cutoff) {
      buffer.shift();
    }

    if (nowMsLocal - lastBreathingAnalysisRef.current >= BREATHING_ANALYSIS_INTERVAL_MS) {
      lastBreathingAnalysisRef.current = nowMsLocal;

      // Descartar nodos que dejaron de transmitir para no mostrar veredictos viejos.
      const staleCutoff = nowMsLocal - NODE_ACTIVE_WINDOW_MS;
      for (const [id, buf] of buffers) {
        if (buf.length === 0 || buf[buf.length - 1].timestampMs < staleCutoff) {
          buffers.delete(id);
        }
      }

      const results: BreathingByNode[] = [];
      for (const [id, buf] of buffers) {
        results.push({ nodeId: id, result: analyzeBreathing(buf) });
      }
      results.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      setBreathingByNode(results);
    }
  }, [rawCsiFrame]);

  // Renderizar Espectrograma Waterfall de 64 Subportadoras
  useEffect(() => {
    const canvas = waterfallRef.current;
    if (!canvas || csiHistory.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

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
            BUSCADOR TÁCTICO RADAR
          </h2>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{activeZoneName}</span>
          {' · '}
          <span
            data-testid="build-id"
            title="Versión cargada. Si no coincide con el último despliegue, el service worker está sirviendo caché vieja."
            style={{ fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace' }}
          >
            build {typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '?'}
          </span>
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

      {/* Identificador de Nodos ESP Conectados en Zona */}
      <div style={{ margin: '12px 0', background: '#161b22', padding: '12px 16px', borderRadius: '10px', border: '1px solid #21262d' }}>
        <div style={{ fontSize: '0.7rem', color: '#8b949e', letterSpacing: '0.5px', marginBottom: '8px', fontWeight: 600 }}>
          NODOS ESP CONECTADOS EN ZONA ({activeNodes.length})
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {activeNodes.length > 0 ? (
            activeNodes.map((node) => (
              <div
                key={node.node_id}
                style={{
                  background: '#0d1117',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #30363d',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '0.75rem',
                }}
              >
                <span style={{ color: '#10b981', fontWeight: 'bold' }}>[ONLINE]</span>
                <span style={{ fontWeight: 700, color: '#f8fafc' }}>{node.node_id}</span>
                {/* RSSI crudo en dBm: dato real reportado por el nodo. Nunca se
                    convierte a metros — ver comentario de cabecera del archivo. */}
                <span style={{ color: '#8b949e' }}>| {node.rssi ?? '—'} dBm</span>
                <span
                  style={{
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    background: node.motion > 0.6 ? '#f97316' : node.motion > 0.3 ? '#eab308' : '#10b981',
                    color: '#000000',
                    marginLeft: '4px',
                  }}
                >
                  {(node.motion * 100).toFixed(0)}%
                </span>
              </div>
            ))
          ) : (
            <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>Esperando reporte de nodos ESP...</span>
          )}
        </div>
      </div>

      {/* Indicador de Tendencia de Proximidad por RSSI */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
        <div
          style={{
            background: '#161b22',
            padding: '20px 28px',
            borderRadius: '10px',
            border: '1px solid #21262d',
            textAlign: 'center',
            minWidth: '240px',
          }}
        >
          <div style={{ fontSize: '0.7rem', color: '#8b949e', letterSpacing: '0.5px', marginBottom: '8px' }}>
            SEÑAL RSSI (NODOS CONECTADOS: {activeNodes.length})
          </div>
          <div data-testid="rssi-trend-value" style={{ fontSize: '2rem', fontWeight: 800, color: '#f8fafc' }}>
            {proximity.currentRssi !== null ? `${proximity.currentRssi} dBm` : '—'}
          </div>
          <div
            style={{
              marginTop: '10px',
              display: 'inline-block',
              padding: '4px 14px',
              borderRadius: '6px',
              fontSize: '0.8rem',
              fontWeight: 800,
              color: proximityDisplay.color,
              border: `1px solid ${proximityDisplay.color}`,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {proximityDisplay.label}
          </div>
        </div>
      </div>

      {/* Detección de Patrón Respiratorio por CSI (reemplaza el panel de
          "triangulación" fabricado — ver comentario de cabecera del archivo) */}
      <div style={{ margin: '12px 0', background: '#161b22', padding: '14px', borderRadius: '10px', border: '1px solid #21262d' }}>
        <div style={{ fontSize: '0.7rem', color: '#8b949e', letterSpacing: '0.5px', marginBottom: '10px', fontWeight: 600 }}>
          DETECCIÓN DE PATRÓN RESPIRATORIO (CSI)
        </div>

        {breathingByNode.length === 0 && (
          <div style={{ textAlign: 'center', padding: '6px' }}>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#8b949e' }}>
              SIN TRAMAS CSI
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: breathingByNode.length > 1 ? '1fr 1fr' : '1fr',
            gap: '8px',
          }}
        >
          {breathingByNode.map(({ nodeId, result }) => (
            <div
              key={nodeId}
              data-testid={`breathing-${nodeId}`}
              style={{
                background: '#0d1117',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #30363d',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '4px' }}>{nodeId}</div>

              {result.status === 'insufficient_data' && (
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#eab308' }}>
                  ACUMULANDO DATOS… {Math.round(result.windowSeconds)} s
                </div>
              )}

              {result.status === 'detected' && (
                <>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: '#10b981' }}>
                    PATRÓN RESPIRATORIO DETECTADO
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#f8fafc', marginTop: '4px' }}>
                    {result.bpm !== null ? `${result.bpm.toFixed(1)} resp/min` : '—'}
                    {' · '}
                    Confianza: {(result.confidence * 100).toFixed(0)}%
                  </div>
                </>
              )}

              {result.status === 'not_detected' && (
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#8b949e' }}>
                  SIN PATRÓN RESPIRATORIO
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: '8px', fontSize: '0.65rem', color: '#64748b', lineHeight: 1.4, textAlign: 'center' }}>
          Requiere zona en silencio y sin movimiento durante ~1 minuto: el movimiento del propio rescatista enmascara la señal de respiración.
          &quot;Sin patrón&quot; no significa &quot;no hay nadie&quot;, sino que no se pudo confirmar con esta muestra.
        </div>
      </div>

      {/* Métricas de Señal en Tiempo Real */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', margin: '12px 0' }}>
        <div style={{ background: '#161b22', padding: '8px 12px', borderRadius: '8px', border: '1px solid #21262d', textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: '#8b949e' }}>PROBABILIDAD CSI</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: currentMotionProb > 0.5 ? '#f97316' : '#10b981' }}>
            {(currentMotionProb * 100).toFixed(0)}%
          </div>
        </div>

        <div style={{ background: '#161b22', padding: '8px 12px', borderRadius: '8px', border: '1px solid #21262d', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: '#8b949e', marginBottom: '2px' }}>ACÚSTICA (GOLPE)</div>
          {startError ? (
            <div style={{ fontSize: '0.6rem', color: '#ef4444', fontWeight: 700, marginTop: '2px' }}>
              {startError}
            </div>
          ) : !isAudioListening ? (
            <button
              type="button"
              onClick={onToggleAudio}
              style={{
                marginTop: '2px',
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '0.65rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ACTIVAR MICRO
            </button>
          ) : (
            <>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: isKnockAlert ? '#ef4444' : '#10b981' }}>
                {isKnockAlert ? 'ALERTA' : `${(rmsLevel * 100).toFixed(0)}%`}
              </div>
              {directionAngle !== null && directionAngle !== undefined && (
                <div style={{ fontSize: '0.6rem', color: '#38bdf8', fontWeight: 700, marginTop: '2px' }}>
                  {directionAngle < -5
                    ? `${Math.abs(directionAngle).toFixed(0)}° IZQ`
                    : directionAngle > 5
                    ? `${directionAngle.toFixed(0)}° DER`
                    : '0° FRENTE'}
                </div>
              )}
            </>
          )}
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
