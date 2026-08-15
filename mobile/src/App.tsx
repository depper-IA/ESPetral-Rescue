/**
 * Componente raíz de la aplicación ESPetral Rescue.
 *
 * Integra las 5 áreas funcionales principales:
 * 1. GPS: captura manual vía navigator.geolocation, persistencia encriptada
 * 2. Audio: motor Web Audio (RMS + visualizadores) integrado con detección
 *    de patrones de golpe (knock patterns) que dispara alertas visuales y de
 *    vibración.
 * 3. Mapa: visualización de ubicaciones registradas vía MapView (Leaflet)
 * 4. Sync: conexión WebSocket al backend con reintentos y ack
 * 5. Acciones: compartir última ubicación, limpiar registro
 *
 * Requisitos cubiertos en esta versión:
 * - 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7: detección acústica + knock + alertas
 * - 5.1, 5.2, 5.3, 5.4, 5.5: GPS con persistencia encriptada y clear log
 * - 2.1, 2.2, 2.4: Web Share API con fallback clipboard + confirmación visual
 * - 3.1-3.5: Visualización en mapa (delegado a MapView)
 * - 8.1, 8.2, 8.4, 8.5: Sync con reintentos e indicador offline persistente
 * - 13.x: Sync remoto de entradas de ubicación con ack (delegado al sync engine)
 *
 * Pendiente (futuro sprint):
 * - Requisito 4.x: PWA + offline shell
 */

import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { LocationEngine, type LocationEntry, type LocationEngineStatus } from './location/location-engine';
import { shareLocation, showClipboardConfirmation } from './location/share-location';
import { MapView } from './location/MapView';
import { ClearLogDialog } from './location/ClearLogDialog';
import { SyncEngine, type ZoneAlert, type ConnectionState } from './sync/sync-engine';
import { useAudioEngine, type AudioEngineState } from './audio/useAudioEngine';
import { useKnockDetector, type KnockDetectorState } from './audio/useKnockDetector';
import { AudioVisualizers } from './audio/AudioVisualizers';
import { AudioDebugPanel } from './audio/AudioDebugPanel';
import { KnockStatus, KnockAlertBanner } from './audio/KnockStatus';
import { useLocationEntrySync } from './sync/useLocationEntrySync';
import { getOrCreateDeviceToken } from './sync/device-token';
import { appStyles } from './App.styles';
import { RadarSeeker } from './radar/RadarSeeker';
import type { RawCsiFrame } from './sync/sync-engine';

/**
 * Alto reservado (px) para el contenido cuando la barra de sync fija está
 * activa (Fix 4). Debe cubrir el alto real de `.cali-sync-bar-fixed` más
 * el padding-top base de `.cali-app` (16px) para que el contenido no quede
 * tapado. Valor con margen de seguridad, no pixel-perfect.
 */
const SYNC_BAR_OFFSET_PX = 56;

/**
 * Alto reservado (px) para el contenido cuando el banner de alerta de
 * golpe está activo (Fix 1). Debe cubrir el alto real de
 * `.cali-knock-alert-banner` (título + detalle, posible wrap en pantallas
 * angostas) más el padding-top base de `.cali-app` (16px).
 */
const ALERT_BANNER_OFFSET_PX = 108;

/**
 * URL del backend WebSocket relay. Configurable vía env en build
 * (VITE_BACKEND_WS_URL) para casos que lo requieran explícitamente; por
 * defecto se deriva del host con el que se cargó la página, para que la
 * PWA siga funcionando sin rebuild cuando cambia la red de despliegue
 * (WiFi externo, hotspot, o el propio ESP32 en modo SoftAP).
 */
function resolveBackendWsUrl(): string {
  const fromEnv = (import.meta as { env?: { VITE_BACKEND_WS_URL?: string } }).env?.VITE_BACKEND_WS_URL;
  if (fromEnv && typeof fromEnv === 'string') {
    return fromEnv;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.hostname}:9001`;
  }
  return 'ws://localhost:9001';
}

/** Mapea estado de conexión a etiqueta legible para UI */
function connectionStateLabel(state: ConnectionState, persistentOffline: boolean): string {
  if (persistentOffline) return 'Sin conexión persistente';
  switch (state) {
    case 'connected':
      return 'Conectado al backend';
    case 'connecting':
      return 'Conectando...';
    case 'disconnected':
      return 'Desconectado';
  }
}

/** Indicador visual del estado de sync */
function SyncIndicator({ state, persistentOffline }: { state: ConnectionState; persistentOffline: boolean }): ReactNode {
  const label = connectionStateLabel(state, persistentOffline);
  const colorClass = persistentOffline
    ? 'cali-sync-offline'
    : state === 'connected'
      ? 'cali-sync-connected'
      : state === 'connecting'
        ? 'cali-sync-connecting'
        : 'cali-sync-disconnected';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`cali-sync-indicator ${colorClass}`}
    >
      <span className="cali-sync-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Fix 4: barra de sync persistente, fija en la parte superior del
 * viewport, visible sin importar el scroll de la página. Solo se renderiza
 * cuando no hay una alerta de golpe activa: el banner de alerta (Fix 1)
 * tiene prioridad visual absoluta y ocupa ese mismo espacio.
 */
function SyncStatusBar({ state, persistentOffline }: { state: ConnectionState; persistentOffline: boolean }): ReactNode {
  return (
    <div className="cali-sync-bar-fixed">
      <SyncIndicator state={state} persistentOffline={persistentOffline} />
    </div>
  );
}

/** Sección GPS con captura y estado de almacenamiento */
function GpsSection({
  engineStatus,
  note,
  onNoteChange,
  onCapture,
  captureError,
}: {
  engine: LocationEngine;
  engineStatus: LocationEngineStatus | null;
  note: string;
  onNoteChange: (next: string) => void;
  onCapture: () => void;
  captureError: string | null;
}): ReactNode {
  const entriesCount = engineStatus?.entryCount ?? 0;
  const storageNote = engineStatus && !engineStatus.localStorageAvailable
    ? ' (almacenamiento solo en memoria)'
    : '';

  return (
    <section className="cali-section cali-gps-section" aria-labelledby="gps-heading">
      <h2 id="gps-heading">Ubicación GPS</h2>
      <p className="cali-section-meta">
        {entriesCount} ubicaciones registradas{storageNote}
      </p>
      <label htmlFor="gps-note" className="cali-label">
        Nota (opcional)
      </label>
      <input
        id="gps-note"
        type="text"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Ej. Sector norte, posible señal"
        aria-label="Nota para la ubicación a registrar"
        className="cali-input"
      />
      <button
        type="button"
        onClick={onCapture}
        className="cali-button cali-button-primary"
      >
        Registrar ubicación actual
      </button>
      {captureError && (
        <p role="alert" className="cali-error">
          {captureError}
        </p>
      )}
    </section>
  );
}

/** Props de la sección de audio. */
interface AudioSectionProps {
  rmsLevel: number;
  isListening: boolean;
  onToggle: () => void;
  startError: string | null;
  analyserNode: AnalyserNode | null;
  sampleRate: number | null;
  knockState: KnockDetectorState;
  audioState: AudioEngineState;
  debugMode: boolean;
  onToggleDebug: () => void;
}

/** Sección de audio con medidor RMS, visualizadores y detector de golpes */
function AudioSection({
  rmsLevel,
  isListening,
  onToggle,
  startError,
  analyserNode,
  sampleRate,
  knockState,
  audioState,
  debugMode,
  onToggleDebug,
}: AudioSectionProps): ReactNode {
  const pct = Math.min(100, Math.max(0, rmsLevel * 100));
  return (
    <section className="cali-section cali-audio-section" aria-labelledby="audio-heading">
      <h2 id="audio-heading">Detección acústica</h2>
      <p className="cali-section-meta">
        Estado: {isListening ? 'Escuchando' : 'Detenido'}
      </p>
      <AudioVisualizers analyserNode={analyserNode} sampleRate={sampleRate} />
      {debugMode && (
        <AudioDebugPanel
          rmsLevel={audioState.rmsLevel}
          noiseFloor={audioState.noiseFloor}
          currentThreshold={audioState.currentThreshold}
          currentCentroid={audioState.currentCentroid}
          peaksDetected={audioState.peaksDetected}
          peaksFilteredByCentroid={knockState.peaksFilteredByCentroid}
          peaksInWindow={knockState.peaksInWindow}
          alertActive={knockState.alertActive}
        />
      )}
      <div className="cali-rms-meter" aria-hidden="true">
        <div className="cali-rms-bar" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <p className="cali-rms-readout">
        Nivel RMS: {(rmsLevel * 100).toFixed(0)}%
      </p>
      <KnockStatus knockState={knockState} />
      <button
        type="button"
        onClick={onToggle}
        className={`cali-button ${isListening ? 'cali-button-warn' : 'cali-button-primary'}`}
      >
        {isListening ? 'Detener escucha' : 'Iniciar escucha'}
      </button>
      <button
        type="button"
        onClick={onToggleDebug}
        className="cali-button cali-debug-toggle"
        aria-pressed={debugMode}
      >
        Debug {debugMode ? 'ON' : 'OFF'}
      </button>
      {startError && (
        <p role="alert" className="cali-error">
          {startError}
        </p>
      )}
    </section>
  );
}

/** Panel de alertas de zona recibidas del backend */
function AlertsPanel({ alerts }: { alerts: readonly ZoneAlert[] }): ReactNode {
  if (alerts.length === 0) return null;
  return (
    <section className="cali-section cali-alerts-section" aria-labelledby="alerts-heading">
      <h3 id="alerts-heading">Alertas recientes ({alerts.length})</h3>
      <ul className="cali-alerts-list">
        {alerts.slice(0, 5).map((alert, i) => (
          <li key={`${alert.zone_id}-${alert.timestamp}-${i}`} className="cali-alert-item">
            <strong>Zona {alert.zone_id}</strong>:{' '}
            {(alert.motion_probability * 100).toFixed(0)}% —{' '}
            <time dateTime={alert.timestamp}>
              {new Date(alert.timestamp).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App(): ReactNode {
  // Motores y estado principal
  const engineRef = useRef<LocationEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new LocationEngine();
  }
  const engine = engineRef.current;

  const syncRef = useRef<SyncEngine | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new SyncEngine({ url: resolveBackendWsUrl() });
  }
  const sync = syncRef.current;

  // Token de dispositivo: estable durante toda la sesión (no es auth, solo deduplicación)
  const deviceToken = useMemo(() => getOrCreateDeviceToken(), []);

  // Hook de sincronización de entradas de ubicación con ack (Req 13.x)
  const locationSync = useLocationEntrySync(engine, sync, deviceToken);

  const [entries, setEntries] = useState<LocationEntry[]>([]);
  const [engineStatus, setEngineStatus] = useState<LocationEngineStatus | null>(null);
  const [note, setNote] = useState('');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<ConnectionState>('disconnected');
  const [persistentOffline, setPersistentOffline] = useState(false);
  const [alerts, setAlerts] = useState<readonly ZoneAlert[]>([]);
  const [rawCsiFrame, setRawCsiFrame] = useState<RawCsiFrame | null>(null);
  const [activeTab, setActiveTab] = useState<'radar' | 'audio' | 'map' | 'gps'>('radar');
  const [debugMode, setDebugMode] = useState(false);

  // Audio engine
  const [audioState, audioControls] = useAudioEngine();
  const [audioStartError, setAudioStartError] = useState<string | null>(null);

  // Detector de patrones de golpe (knock patterns) integrado con el motor de audio
  const [knockState, knockControls] = useKnockDetector({
    analyserNode: audioState.analyserNode,
    sampleRate: audioState.sampleRate ?? 44100,
  });

  // Init effects
  useEffect(() => {
    let active = true;
    void engine.initialize().then(() => {
      if (!active) return;
      setEntries(engine.getEntries());
      setEngineStatus(engine.status);
    });

    const unsubscribe = engine.on(() => {
      if (!active) return;
      setEntries(engine.getEntries());
      setEngineStatus(engine.status);
    });

    sync.setListener({
      onConnectionStateChange: (s) => {
        if (active) {
          setSyncState(s);
          locationSync.handleConnectionStateChange(s);
        }
      },
      onAlert: (a) => active && setAlerts((prev) => [a, ...prev].slice(0, 50)),
      onRawCsi: (frame) => active && setRawCsiFrame(frame),
      onPersistentOffline: (off) => active && setPersistentOffline(off),
      onSyncAck: (ack) => active && locationSync.handleSyncAck(ack),
    });
    sync.connect();

    return () => {
      active = false;
      unsubscribe();
      sync.disconnect();
    };
  }, [engine, sync]);

  // Conecta los picos detectados por el motor de audio al detector de patrones.
  // Deps: solo las funciones internas estables para evitar re-renders infinitos
  // (los tuples [state, controls] recrean el objeto control cada render).
  useEffect(() => {
    audioControls.onPeak((timestamp: number) => {
      knockControls.processPeak(timestamp);
    });
    return () => {
      audioControls.onPeak(null);
    };
  }, [audioControls.onPeak, knockControls.processPeak]);

  // Sincroniza el ciclo de vida del detector de golpes con el motor de audio.
  useEffect(() => {
    if (audioState.isListening) {
      void knockControls.start();
    } else {
      knockControls.stop();
    }
  }, [audioState.isListening, knockControls.start, knockControls.stop]);

  // Tarea 7.3: Enviar reporte acústico al backend cuando se detecta un patrón de golpe.
  // Solo se envía en la transición a true para evitar envíos duplicados.
  const prevAlertActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = prevAlertActiveRef.current;
    prevAlertActiveRef.current = knockState.alertActive;

    // Disparar solo en la transición false → true
    if (!knockState.alertActive || wasActive) return;

    // Envío best-effort: si no hay conexión, se omite silenciosamente
    if (sync.getConnectionState() !== 'connected') return;

    sync.send('cali/acoustic/report', {
      device_token: deviceToken,
      // Mejor aproximación de zona: última entrada GPS conocida
      lat: entries[0]?.lat ?? null,
      lon: entries[0]?.lon ?? null,
      peak_count: knockState.lastPattern?.peakCount ?? 3,
      mean_interval_ms: knockState.lastPattern?.meanInterval ?? 0,
      confidence: knockState.lastPattern?.confidence ?? 0.5,
      timestamp: new Date().toISOString(),
    });
  }, [knockState.alertActive, knockState.lastPattern, sync, deviceToken, entries]);

  // GPS capture
  const handleCapture = useCallback(() => {
    setCaptureError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setCaptureError('Geolocalización no disponible en este navegador');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await engine.addEntry(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy,
          note.trim(),
        );
        setNote('');
        // Disparar sync inmediato tras nueva entrada (Req 13.x)
        locationSync.triggerSync();
      },
      (err) => {
        setCaptureError(`Error GPS: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    );
  }, [engine, note]);

  // Share last entry
  const handleShare = useCallback(async () => {
    if (entries.length === 0) return;
    const result = await shareLocation(entries[0]);
    if (result.method === 'clipboard') {
      showClipboardConfirmation();
    }
  }, [entries]);

  // Audio toggle
  const handleToggleAudio = useCallback(async () => {
    setAudioStartError(null);
    if (audioState.isListening) {
      audioControls.stop();
    } else {
      try {
        await audioControls.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error desconocido';
        setAudioStartError(`No se pudo iniciar audio: ${msg}`);
      }
    }
  }, [audioState.isListening, audioControls]);

  // Toggle del panel de debug acustico
  const handleToggleDebug = useCallback(() => {
    setDebugMode((prev) => !prev);
  }, []);

  return (
    <div
      className="cali-app"
      style={{
        paddingTop: knockState.alertActive ? ALERT_BANNER_OFFSET_PX : SYNC_BAR_OFFSET_PX,
      }}
    >
      {/* Fix 1: banner de alerta de golpe, fijo y dominante. Tiene prioridad
          absoluta sobre la barra de sync (Fix 4), que se oculta mientras
          la alerta esté activa. */}
      <KnockAlertBanner knockState={knockState} />
      {!knockState.alertActive && (
        <SyncStatusBar state={syncState} persistentOffline={persistentOffline} />
      )}

      <header className="cali-header">
        <h1>ESPetral Rescue</h1>
        <p className="cali-tagline">Buscador táctico de presencia humana y rescate</p>
      </header>

      {/* Navegación Táctica Unificada (48px touch targets) */}
      <nav
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '4px',
          padding: '6px 12px',
          background: '#161b22',
          borderBottom: '1px solid #30363d',
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab('radar')}
          style={{
            minHeight: '48px',
            padding: '8px 4px',
            background: activeTab === 'radar' ? '#238636' : '#21262d',
            color: activeTab === 'radar' ? '#fff' : '#8b949e',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          <span>RADAR</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('audio')}
          style={{
            minHeight: '48px',
            padding: '8px 4px',
            background: activeTab === 'audio' ? '#238636' : '#21262d',
            color: activeTab === 'audio' ? '#fff' : '#8b949e',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          <span>GOLPES</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('map')}
          style={{
            minHeight: '48px',
            padding: '8px 4px',
            background: activeTab === 'map' ? '#238636' : '#21262d',
            color: activeTab === 'map' ? '#fff' : '#8b949e',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          <span>MAPA</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('gps')}
          style={{
            minHeight: '48px',
            padding: '8px 4px',
            background: activeTab === 'gps' ? '#238636' : '#21262d',
            color: activeTab === 'gps' ? '#fff' : '#8b949e',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          <span>GPS</span>
        </button>
      </nav>

      <main style={{ padding: '12px' }}>
        {/* Pestaña Principal: RADAR Seeker Táctico + Waterfall CSI */}
        {activeTab === 'radar' && (
          <RadarSeeker
            alerts={alerts}
            rawCsiFrame={rawCsiFrame}
            knockState={knockState}
            isConnected={syncState === 'connected'}
            isAudioListening={audioState.isListening}
            onToggleAudio={handleToggleAudio}
            rmsLevel={audioState.rmsLevel}
            startError={audioStartError}
            directionAngle={audioState.directionAngle}
          />
        )}

        {/* Pestaña: Detector de Golpes Acústico */}
        {activeTab === 'audio' && (
          <AudioSection
            rmsLevel={audioState.rmsLevel}
            isListening={audioState.isListening}
            onToggle={handleToggleAudio}
            startError={audioStartError}
            analyserNode={audioState.analyserNode}
            sampleRate={audioState.sampleRate}
            knockState={knockState}
            audioState={audioState}
            debugMode={debugMode}
            onToggleDebug={handleToggleDebug}
          />
        )}

        {/* Pestaña Secundaria: Mapa de Zonas y Ubicaciones */}
        {activeTab === 'map' && (
          <>
            <AlertsPanel alerts={alerts} />
            <section className="cali-section cali-map-section" aria-labelledby="map-heading">
              <h2 id="map-heading">Mapa de ubicaciones</h2>
              {entries.length === 0 ? (
                <p className="cali-section-meta">Sin ubicaciones registradas aún.</p>
              ) : (
                <MapView entries={entries} height="360px" />
              )}
            </section>
          </>
        )}

        {/* Pestaña Secundaria: Registro GPS y Acciones */}
        {activeTab === 'gps' && (
          <>
            <GpsSection
              engine={engine}
              engineStatus={engineStatus}
              note={note}
              onNoteChange={setNote}
              onCapture={handleCapture}
              captureError={captureError}
            />
            <section className="cali-section cali-actions-section" aria-labelledby="actions-heading">
              <h2 id="actions-heading">Acciones</h2>
              <div className="cali-actions-buttons">
                <button
                  type="button"
                  onClick={handleShare}
                  disabled={entries.length === 0}
                  className="cali-button"
                  aria-label="Compartir la última ubicación registrada"
                >
                  Compartir última ubicación
                </button>
                <ClearLogDialog
                  engine={engine}
                  onCleared={() => setEntries([])}
                  disabled={entries.length === 0}
                />
              </div>
            </section>
          </>
        )}
      </main>

      {/* Estilos inline para no requerir CSS modules en este commit.
          Definidos en App.styles.ts (extraídos para respetar el umbral de
          600 líneas por archivo). */}
      <style>{appStyles}</style>
    </div>
  );
}

