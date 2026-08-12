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
import { KnockStatus } from './audio/KnockStatus';
import { useLocationEntrySync } from './sync/useLocationEntrySync';
import { getOrCreateDeviceToken } from './sync/device-token';

/** URL del backend WebSocket relay. Configurable vía env en build. */
function resolveBackendWsUrl(): string {
  // En Vite, import.meta.env.VITE_BACKEND_WS_URL permite override en build
  const fromEnv = (import.meta as { env?: { VITE_BACKEND_WS_URL?: string } }).env?.VITE_BACKEND_WS_URL;
  if (fromEnv && typeof fromEnv === 'string') {
    return fromEnv;
  }
  // Fallback razonable para dev local
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return 'wss://localhost:9001';
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
        <div className="cali-rms-bar" style={{ width: `${pct}%` }} />
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
    <div className="cali-app">
      <header className="cali-header">
        <h1>ESPetral Rescue</h1>
        <p className="cali-tagline">Herramienta de campo para búsqueda y rescate</p>
        <SyncIndicator state={syncState} persistentOffline={persistentOffline} />
      </header>

      <main>
        <GpsSection
          engine={engine}
          engineStatus={engineStatus}
          note={note}
          onNoteChange={setNote}
          onCapture={handleCapture}
          captureError={captureError}
        />

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

        <AlertsPanel alerts={alerts} />

        <section className="cali-section cali-map-section" aria-labelledby="map-heading">
          <h2 id="map-heading">Mapa de ubicaciones</h2>
          {entries.length === 0 ? (
            <p className="cali-section-meta">Sin ubicaciones registradas aún.</p>
          ) : (
            <MapView entries={entries} height="320px" />
          )}
        </section>

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
      </main>

      {/* Estilos inline para no requerir CSS modules en este commit */}
      <style>{appStyles}</style>
    </div>
  );
}

/** Estilos inline del App. Mantener aquí hasta que se introduzca un sistema de estilos. */
const appStyles = `
  .cali-app {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 720px;
    margin: 0 auto;
    padding: 16px;
    color: #1a1a1a;
    background: #fff;
  }

  .cali-header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e0e0e0;
  }
  .cali-header h1 {
    margin: 0 0 4px 0;
    font-size: 24px;
  }
  .cali-tagline {
    margin: 0 0 12px 0;
    color: #555;
    font-size: 14px;
  }

  .cali-sync-indicator {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  .cali-sync-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .cali-sync-connected { background: #e6f4ea; color: #1e7a3a; }
  .cali-sync-connecting { background: #fff4e5; color: #a8540c; }
  .cali-sync-disconnected { background: #f0f0f0; color: #555; }
  .cali-sync-offline { background: #fde7e9; color: #b3243a; }

  .cali-section {
    margin-bottom: 24px;
    padding: 16px;
    background: #fafafa;
    border-radius: 8px;
    border: 1px solid #eee;
  }
  .cali-section h2 {
    margin: 0 0 8px 0;
    font-size: 18px;
  }
  .cali-section h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
  }
  .cali-section-meta {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #555;
  }
  .cali-section-footnote {
    margin: 12px 0 0 0;
    font-size: 12px;
    color: #888;
    font-style: italic;
  }

  .cali-label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 6px;
  }
  .cali-input {
    width: 100%;
    padding: 12px 16px;
    font-size: 16px;
    border: 1px solid #ccc;
    border-radius: 6px;
    margin-bottom: 12px;
    min-height: 48px;
    box-sizing: border-box;
  }

  .cali-button {
    min-height: 48px;
    min-width: 48px;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 600;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    background: #f0f0f0;
    color: #1a1a1a;
    touch-action: manipulation;
  }
  .cali-button:hover:not(:disabled) {
    background: #e5e5e5;
  }
  .cali-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cali-button-primary {
    background: #1976d2;
    color: #fff;
  }
  .cali-button-primary:hover:not(:disabled) {
    background: #155fa0;
  }
  .cali-button-warn {
    background: #f57c00;
    color: #fff;
  }
  .cali-button-warn:hover:not(:disabled) {
    background: #d96b00;
  }
  .cali-button-danger {
    background: #d32f2f;
    color: #fff;
  }
  .cali-button-danger:hover:not(:disabled) {
    background: #b71c1c;
  }

  .cali-actions-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .cali-error {
    margin: 8px 0 0 0;
    padding: 8px 12px;
    background: #fde7e9;
    color: #b3243a;
    border-radius: 4px;
    font-size: 14px;
  }

  .cali-rms-meter {
    width: 100%;
    height: 8px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .cali-rms-bar {
    height: 100%;
    background: #4caf50;
    transition: width 100ms ease-out;
  }
  .cali-rms-readout {
    margin: 0 0 12px 0;
    font-size: 12px;
    color: #666;
  }

  .cali-visualizers {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 12px 0;
  }
  .cali-waveform-canvas,
  .cali-spectrum-canvas {
    width: 100%;
    background: #0a0a0a;
    border-radius: 4px;
    display: block;
  }
  .cali-waveform-canvas { height: 80px; }
  .cali-spectrum-canvas { height: 100px; }

  .cali-knock-status {
    margin-top: 12px;
    padding: 12px;
    border-radius: 4px;
    background: #f5f5f5;
    font-size: 14px;
  }
  .cali-knock-line {
    margin: 0 0 4px 0;
    font-size: 14px;
  }
  .cali-knock-last-pattern {
    margin: 6px 0 0 0;
    font-size: 13px;
    color: #444;
  }
  .cali-knock-alert {
    margin-top: 8px;
    padding: 10px 12px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.5px;
  }
  .cali-knock-status[data-active='true'] {
    background: #d32f2f;
    color: white;
    animation: cali-alert-pulse 0.5s ease-in-out infinite alternate;
  }
  @keyframes cali-alert-pulse {
    from { background: #d32f2f; }
    to { background: #b71c1c; }
  }

  .cali-alerts-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .cali-alert-item {
    padding: 8px 12px;
    background: #fff4e5;
    border-left: 3px solid #f57c00;
    border-radius: 4px;
    margin-bottom: 6px;
    font-size: 14px;
  }

  .cali-debug-panel {
    margin-top: 12px;
    padding: 12px;
    background: #1a1a2e;
    color: #e0e0e0;
    border-radius: 4px;
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
  .cali-debug-panel-title {
    font-weight: bold;
    margin-bottom: 8px;
    color: #a0a0ff;
  }
  .cali-debug-row {
    display: flex;
    justify-content: space-between;
  }
  .cali-debug-divider {
    border-top: 1px solid #444;
    margin: 8px 0;
  }
  .cali-debug-panel[data-active='true'] {
    border: 2px solid #ff5252;
  }
  .cali-debug-toggle {
    font-size: 12px;
    padding: 4px 8px;
    margin-left: 8px;
  }
`;
