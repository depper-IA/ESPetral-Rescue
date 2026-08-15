/**
 * ESPetral Rescue — WebSocket Relay para conexiones de apps móviles
 *
 * Servidor WebSocket en puerto 9001 (según design.md: "Mobile App → Backend |
 * WebSocket Secure | 9001") que conecta apps móviles al broker MQTT.
 * Protocolo JSON (no MQTT) para sincronización de ubicaciones, reportes
 * acústicos y retransmisión de alertas CSI a clientes móviles suscritos.
 *
 * Funcionalidades:
 * - Recibe batches de ubicación (`cali/sync/entries`), valida, deduplica y almacena en SQLite
 * - Envía acknowledgments (`cali/sync/ack`) con IDs confirmados
 * - Recibe reportes acústicos (`cali/sync/acoustic`), resuelve la zona por proximidad GPS,
 *   los almacena en `acoustic_reports` y notifica para recalcular el scoring
 * - Retransmite mensajes `cali/zone/+/csi` a clientes móviles suscritos
 *
 * Requisitos: 8.1, 8.2, 11.5, 13.1, 13.2
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import type Database from 'better-sqlite3';
import type Aedes from 'aedes';
import mqtt from 'mqtt';
import { approximateDistanceMeters } from './scoring-engine.js';
import type { LocationSyncBatch, LocationSyncAck, LocationEntry } from './types.js';

// --- Constantes ---

/** Puerto por defecto para el relay WebSocket de apps móviles (design.md: 9001) */
export const DEFAULT_RELAY_PORT = 9001;

/** Máximo de entradas por batch de sincronización */
export const MAX_BATCH_SIZE = 50;

/** Tópico para sincronización de ubicaciones (entrada) */
const SYNC_ENTRIES_TOPIC = 'cali/sync/entries';

/** Tópico para acknowledgment de sincronización (salida) */
const SYNC_ACK_TOPIC = 'cali/sync/ack';

/** Tópico para envío de reportes acústicos (entrada) */
const SYNC_ACOUSTIC_TOPIC = 'cali/sync/acoustic';

/** Tópico para acknowledgment de reportes acústicos (salida) */
const SYNC_ACOUSTIC_ACK_TOPIC = 'cali/sync/acoustic_ack';

/** Patrón para tópicos CSI de zonas */
const CSI_TOPIC_PREFIX = 'cali/zone/';
const CSI_TOPIC_SUFFIX = '/csi';

// --- Tipos de mensajes del protocolo JSON ---

/** Mensaje entrante desde la app móvil */
export interface RelayIncomingMessage {
  type: string;
  payload: unknown;
}

/** Mensaje saliente hacia la app móvil */
export interface RelayOutgoingMessage {
  type: string;
  payload: unknown;
}

/** Mensaje CSI retransmitido a clientes móviles */
export interface CsiRelayMessage {
  zone_id: string;
  node_id: string;
  motion_probability: number;
  timestamp: string;
}

/**
 * Reporte acústico recibido desde la app móvil (sin zone_id: se resuelve
 * server-side por proximidad GPS a partir de lat/lon).
 */
export interface AcousticReportInput {
  /** UUID generado en el dispositivo móvil */
  id: string;
  /** Identificador local del dispositivo (no es un token de autenticación) */
  device_token: string;
  /** Cantidad de picos filtrados en el patrón detectado */
  peak_count: number;
  /** Intervalo medio entre picos en ms */
  mean_interval_ms: number;
  /** Confianza de la detección [0,1] */
  confidence: number;
  /** Latitud del dispositivo al momento del reporte, o null si no hay fix GPS */
  lat: number | null;
  /** Longitud del dispositivo al momento del reporte, o null si no hay fix GPS */
  lon: number | null;
  /** Timestamp ISO 8601 del reporte */
  reported_at: string;
}

/** Reporte acústico ya resuelto a una zona, entregado al callback onAcousticReport */
export interface ResolvedAcousticReport extends AcousticReportInput {
  zone_id: string;
}

// --- Opciones de configuración ---

export interface WsRelayOptions {
  /** Puerto HTTP para el servidor WebSocket (default: 9001) */
  port?: number;
  /** Instancia de base de datos SQLite para almacenamiento */
  db: Database.Database;
  /** URL del broker MQTT para suscripción interna (default: mqtt://localhost:1883) */
  mqttUrl?: string;
  /** Token de autenticación para conexión interna al broker MQTT */
  mqttToken?: string;
  /** Set de tokens válidos para autenticación de dispositivos móviles */
  validTokens?: Set<string>;
  /** Callback invocado cuando se almacena un nuevo reporte de campo (ubicación sincronizada) */
  onFieldReport?: (entry: { id: string; lat: number; lon: number; note: string; captured_at: string }) => void;
  /** Callback invocado cuando se almacena un nuevo reporte acústico, para disparar el recálculo del scoring */
  onAcousticReport?: (report: ResolvedAcousticReport) => void;
}

// --- Interfaz del relay ---

export interface WsRelayInstance {
  /** Servidor HTTP subyacente */
  httpServer: HttpServer;
  /** Servidor WebSocket */
  wss: WebSocketServer;
  /** Cliente MQTT interno para suscripción a tópicos CSI */
  mqttClient: mqtt.MqttClient | null;
  /** Set de clientes WebSocket conectados */
  clients: Set<WebSocket>;
  /** Cierra el relay y libera recursos */
  close(): Promise<void>;
}

// --- Validación de entradas de ubicación ---

/**
 * Valida una entrada de ubicación individual.
 * Retorna null si es válida, o un string con la razón del error.
 */
export function validateLocationEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) {
    return 'La entrada no es un objeto válido';
  }

  const e = entry as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    return 'Campo id ausente o inválido';
  }

  if (typeof e.timestamp !== 'string' || e.timestamp.length === 0) {
    return 'Campo timestamp ausente o inválido';
  }

  if (typeof e.lat !== 'number' || !Number.isFinite(e.lat) || e.lat < -90 || e.lat > 90) {
    return 'Campo lat ausente o fuera de rango [-90, 90]';
  }

  if (typeof e.lon !== 'number' || !Number.isFinite(e.lon) || e.lon < -180 || e.lon > 180) {
    return 'Campo lon ausente o fuera de rango [-180, 180]';
  }

  if (typeof e.accuracy !== 'number' || !Number.isFinite(e.accuracy) || e.accuracy < 0) {
    return 'Campo accuracy ausente o negativo';
  }

  if (typeof e.note !== 'string') {
    return 'Campo note ausente o no es string';
  }

  return null;
}

/**
 * Valida un batch completo de sincronización de ubicaciones.
 * Retorna un objeto con las entradas válidas y los errores encontrados.
 */
export function validateSyncBatch(payload: unknown): {
  valid: boolean;
  entries: LocationEntry[];
  deviceToken: string;
  errors: { id: string; reason: string }[];
} {
  const result = {
    valid: false,
    entries: [] as LocationEntry[],
    deviceToken: '',
    errors: [] as { id: string; reason: string }[],
  };

  if (typeof payload !== 'object' || payload === null) {
    result.errors.push({ id: '', reason: 'Payload no es un objeto válido' });
    return result;
  }

  const batch = payload as Record<string, unknown>;

  // Validar device_token
  if (typeof batch.device_token !== 'string' || batch.device_token.length === 0) {
    result.errors.push({ id: '', reason: 'device_token ausente o inválido' });
    return result;
  }
  result.deviceToken = batch.device_token;

  // Validar entries como array
  if (!Array.isArray(batch.entries)) {
    result.errors.push({ id: '', reason: 'Campo entries no es un array' });
    return result;
  }

  // Validar tamaño del batch (máximo 50 entradas)
  if (batch.entries.length > MAX_BATCH_SIZE) {
    result.errors.push({
      id: '',
      reason: `Batch excede el máximo de ${MAX_BATCH_SIZE} entradas (recibidas: ${batch.entries.length})`,
    });
    return result;
  }

  // Validar cada entrada individual
  for (const entry of batch.entries) {
    const error = validateLocationEntry(entry);
    if (error) {
      const entryId = (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string')
        ? (entry as Record<string, unknown>).id as string
        : 'unknown';
      result.errors.push({ id: entryId, reason: error });
    } else {
      result.entries.push(entry as LocationEntry);
    }
  }

  result.valid = result.entries.length > 0 || result.errors.length === 0;
  return result;
}

// --- Almacenamiento con deduplicación ---

/**
 * Almacena entradas de ubicación en SQLite con deduplicación por ID.
 * Implementa "first received wins": si un ID ya existe, se ignora (no se sobreescribe).
 * Retorna los IDs que fueron efectivamente almacenados (nuevos o ya existentes).
 */
export function storeLocationEntries(
  db: Database.Database,
  entries: LocationEntry[],
  deviceToken: string,
): { storedIds: string[]; duplicateIds: string[] } {
  const storedIds: string[] = [];
  const duplicateIds: string[] = [];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO location_entries (id, device_token, lat, lon, accuracy_m, note, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const checkStmt = db.prepare(`SELECT id FROM location_entries WHERE id = ?`);

  const storeAll = db.transaction(() => {
    for (const entry of entries) {
      // Verificar si ya existe (deduplicación: first received wins)
      const existing = checkStmt.get(entry.id) as { id: string } | undefined;
      if (existing) {
        duplicateIds.push(entry.id);
        // Aún así lo reportamos como acknowledged (ya fue recibido antes)
        storedIds.push(entry.id);
        continue;
      }

      insertStmt.run(
        entry.id,
        deviceToken,
        entry.lat,
        entry.lon,
        entry.accuracy,
        entry.note,
        entry.timestamp,
      );
      storedIds.push(entry.id);
    }
  });

  storeAll();

  if (duplicateIds.length > 0) {
    console.log(
      `[ws-relay] Entradas duplicadas ignoradas: ${duplicateIds.length} (IDs: ${duplicateIds.join(', ')})`
    );
  }

  return { storedIds, duplicateIds };
}

// --- Validación y almacenamiento de reportes acústicos ---

/**
 * Valida un reporte acústico individual recibido desde la app móvil.
 * Retorna el reporte parseado si es válido, o un mensaje de error.
 */
export function validateAcousticReport(payload: unknown): {
  valid: boolean;
  report: AcousticReportInput | null;
  error: string | null;
} {
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, report: null, error: 'El reporte acústico no es un objeto válido' };
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.id !== 'string' || p.id.length === 0) {
    return { valid: false, report: null, error: 'Campo id ausente o inválido' };
  }

  if (typeof p.device_token !== 'string' || p.device_token.length === 0) {
    return { valid: false, report: null, error: 'Campo device_token ausente o inválido' };
  }

  if (typeof p.peak_count !== 'number' || !Number.isInteger(p.peak_count) || p.peak_count < 1) {
    return { valid: false, report: null, error: 'Campo peak_count ausente o inválido' };
  }

  if (typeof p.mean_interval_ms !== 'number' || !Number.isFinite(p.mean_interval_ms) || p.mean_interval_ms < 0) {
    return { valid: false, report: null, error: 'Campo mean_interval_ms ausente o inválido' };
  }

  if (
    typeof p.confidence !== 'number' ||
    !Number.isFinite(p.confidence) ||
    p.confidence < 0 ||
    p.confidence > 1
  ) {
    return { valid: false, report: null, error: 'Campo confidence ausente o fuera de rango [0,1]' };
  }

  if (p.lat !== null && p.lat !== undefined) {
    if (typeof p.lat !== 'number' || !Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
      return { valid: false, report: null, error: 'Campo lat inválido o fuera de rango [-90, 90]' };
    }
  }

  if (p.lon !== null && p.lon !== undefined) {
    if (typeof p.lon !== 'number' || !Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) {
      return { valid: false, report: null, error: 'Campo lon inválido o fuera de rango [-180, 180]' };
    }
  }

  if (typeof p.reported_at !== 'string' || p.reported_at.length === 0) {
    return { valid: false, report: null, error: 'Campo reported_at ausente o inválido' };
  }

  return {
    valid: true,
    error: null,
    report: {
      id: p.id,
      device_token: p.device_token,
      peak_count: p.peak_count,
      mean_interval_ms: p.mean_interval_ms,
      confidence: p.confidence,
      lat: typeof p.lat === 'number' ? p.lat : null,
      lon: typeof p.lon === 'number' ? p.lon : null,
      reported_at: p.reported_at,
    },
  };
}

/**
 * Resuelve la zona más cercana a unas coordenadas dadas, entre las zonas
 * registradas cuyo radio contiene el punto. Retorna null si no hay
 * coordenadas o ninguna zona cubre el punto.
 *
 * La app móvil no conoce el zone_id (no hay selección de zona en el flujo
 * actual), así que el backend resuelve la zona por proximidad GPS —
 * consistente con el cálculo de contribución GPS en `scoring-engine.ts`.
 */
export function resolveZoneForCoordinates(
  db: Database.Database,
  lat: number | null,
  lon: number | null,
): string | null {
  if (lat === null || lon === null) return null;

  const zones = db
    .prepare(`SELECT id, center_lat, center_lon, radius_m FROM zones`)
    .all() as Array<{ id: string; center_lat: number; center_lon: number; radius_m: number }>;

  let closestZoneId: string | null = null;
  let closestDistance = Infinity;

  for (const zone of zones) {
    const distance = approximateDistanceMeters(zone.center_lat, zone.center_lon, lat, lon);
    if (distance <= zone.radius_m && distance < closestDistance) {
      closestDistance = distance;
      closestZoneId = zone.id;
    }
  }

  return closestZoneId;
}

/**
 * Almacena un reporte acústico ya resuelto a una zona en SQLite.
 * Usa INSERT OR IGNORE para idempotencia ante reintentos con el mismo id.
 */
export function storeAcousticReport(
  db: Database.Database,
  zoneId: string,
  report: AcousticReportInput,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO acoustic_reports
      (id, zone_id, device_token, peak_count, mean_interval_ms, confidence, lat, lon, reported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id,
    zoneId,
    report.device_token,
    report.peak_count,
    report.mean_interval_ms,
    report.confidence,
    report.lat,
    report.lon,
    report.reported_at,
  );
}

// --- Creación del relay ---

/**
 * Crea y configura el servidor WebSocket relay para apps móviles.
 *
 * El relay:
 * 1. Escucha en el puerto configurado (default 9001) conexiones WebSocket JSON
 * 2. Procesa mensajes `cali/sync/entries`: valida, deduplica, almacena y responde con ack
 * 3. Procesa mensajes `cali/sync/acoustic`: valida, resuelve zona por GPS, almacena y responde con ack
 * 4. Se suscribe internamente al broker MQTT en `cali/zone/+/csi`
 * 5. Retransmite mensajes CSI a todos los clientes móviles conectados
 */
export function createWsRelay(options: WsRelayOptions): WsRelayInstance {
  const {
    port = DEFAULT_RELAY_PORT,
    db,
    mqttUrl = 'mqtt://localhost:1883',
    mqttToken,
    validTokens = new Set<string>(),
    onFieldReport,
    onAcousticReport,
  } = options;

  const clients = new Set<WebSocket>();
  let mqttClient: mqtt.MqttClient | null = null;

  // --- Servidor HTTP + WebSocket ---
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  // --- Manejo de conexiones WebSocket ---
  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    // Autenticación opcional via query string (?token=xxx)
    const url = new URL(request.url || '/', `http://localhost:${port}`);
    const token = url.searchParams.get('token');

    // Si hay tokens configurados, validar
    if (validTokens.size > 0 && (!token || !validTokens.has(token))) {
      console.log('[ws-relay] Conexión rechazada: token inválido');
      socket.close(4001, 'Token de autenticación inválido');
      return;
    }

    clients.add(socket);
    console.log(`[ws-relay] Cliente móvil conectado (total: ${clients.size})`);

    socket.on('message', (data) => {
      handleClientMessage(socket, data, db, onFieldReport, onAcousticReport);
    });

    socket.on('close', () => {
      clients.delete(socket);
      console.log(`[ws-relay] Cliente móvil desconectado (total: ${clients.size})`);
    });

    socket.on('error', (err) => {
      console.error('[ws-relay] Error en socket del cliente:', err.message);
      clients.delete(socket);
    });
  });

  // --- Suscripción interna al broker MQTT para retransmitir CSI ---
  function connectMqtt(): void {
    const mqttOptions: mqtt.IClientOptions = {
      clientId: `ws-relay-${Date.now()}`,
    };

    if (mqttToken) {
      // MQTT 3.1.1 [MQTT-3.1.2-22]: el flag Password solo es válido si el
      // flag Username también está seteado. Sin username, el CONNECT es
      // inválido y el broker lo rechaza silenciosamente (loop de reconexión
      // infinito, sin evento 'error' legible).
      mqttOptions.username = 'ws-relay';
      mqttOptions.password = mqttToken;
    }

    mqttClient = mqtt.connect(mqttUrl, mqttOptions);

    mqttClient.on('connect', () => {
      console.log('[ws-relay] Conectado al broker MQTT para retransmisión CSI');
      mqttClient!.subscribe(['cali/zone/+/csi', 'cali/zone/+/csi_raw'], (err) => {
        if (err) {
          console.error('[ws-relay] Error al suscribirse a tópicos CSI:', err.message);
        }
      });
    });

    mqttClient.on('message', (topic: string, payload: Buffer) => {
      // Retransmitir mensajes CSI y CSI raw a todos los clientes móviles conectados
      if (topic.startsWith(CSI_TOPIC_PREFIX)) {
        relayCsiToClients(topic, payload, clients);
      }
    });

    mqttClient.on('error', (err) => {
      console.error('[ws-relay] Error en cliente MQTT:', err.message);
    });
  }

  // Conectar al broker MQTT
  connectMqtt();

  // Iniciar servidor HTTP
  httpServer.listen(port, () => {
    console.log(`[ws-relay] Servidor WebSocket para apps móviles escuchando en puerto ${port}`);
  });

  // --- Método de cierre ---
  async function close(): Promise<void> {
    // Cerrar todos los clientes WebSocket
    for (const client of clients) {
      client.close(1000, 'Servidor cerrando');
    }
    clients.clear();

    // Desconectar del broker MQTT
    if (mqttClient) {
      await new Promise<void>((resolve) => {
        mqttClient!.end(false, () => resolve());
      });
      mqttClient = null;
    }

    // Cerrar servidores
    return new Promise((resolve) => {
      wss.close(() => {
        httpServer.close(() => {
          resolve();
        });
      });
    });
  }

  return {
    httpServer,
    wss,
    mqttClient,
    clients,
    close,
  };
}

// --- Handlers internos ---

/**
 * Procesa un mensaje recibido de un cliente móvil.
 * Despacha según el tipo de mensaje.
 */
function handleClientMessage(
  socket: WebSocket,
  data: unknown,
  db: Database.Database,
  onFieldReport?: (entry: { id: string; lat: number; lon: number; note: string; captured_at: string }) => void,
  onAcousticReport?: (report: ResolvedAcousticReport) => void,
): void {
  let message: RelayIncomingMessage;

  try {
    const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf-8');
    message = JSON.parse(raw);
  } catch {
    sendError(socket, 'Mensaje no es JSON válido');
    return;
  }

  if (typeof message.type !== 'string') {
    sendError(socket, 'Campo type ausente o inválido');
    return;
  }

  switch (message.type) {
    case SYNC_ENTRIES_TOPIC:
      handleSyncEntries(socket, message.payload, db, onFieldReport);
      break;
    case SYNC_ACOUSTIC_TOPIC:
      handleAcousticReport(socket, message.payload, db, onAcousticReport);
      break;
    default:
      sendError(socket, `Tipo de mensaje no soportado: ${message.type}`);
      break;
  }
}

/**
 * Maneja un batch de sincronización de ubicaciones.
 * Valida, deduplica, almacena y envía acknowledgment.
 * Notifica al dashboard para cada entrada nueva almacenada.
 */
function handleSyncEntries(
  socket: WebSocket,
  payload: unknown,
  db: Database.Database,
  onFieldReport?: (entry: { id: string; lat: number; lon: number; note: string; captured_at: string }) => void,
): void {
  const validation = validateSyncBatch(payload);

  // Si hay errores estructurales graves (no hay entradas válidas), responder solo con errores
  if (validation.entries.length === 0 && validation.errors.length > 0) {
    const ack: LocationSyncAck = {
      acknowledged_ids: [],
      errors: validation.errors,
    };
    sendMessage(socket, SYNC_ACK_TOPIC, ack);
    return;
  }

  // Almacenar entradas válidas con deduplicación
  const { storedIds, duplicateIds } = storeLocationEntries(db, validation.entries, validation.deviceToken);

  // Notificar al dashboard sobre entradas nuevas (no duplicadas)
  if (onFieldReport) {
    for (const entry of validation.entries) {
      if (!duplicateIds.includes(entry.id)) {
        onFieldReport({
          id: entry.id,
          lat: entry.lat,
          lon: entry.lon,
          note: entry.note,
          captured_at: entry.timestamp,
        });
      }
    }
  }

  // Construir acknowledgment
  const ack: LocationSyncAck = {
    acknowledged_ids: storedIds,
    errors: validation.errors,
  };

  sendMessage(socket, SYNC_ACK_TOPIC, ack);
}

/**
 * Maneja un reporte acústico individual (patrón de golpe detectado en la app móvil).
 * Valida, resuelve la zona por proximidad GPS, almacena y notifica para
 * disparar el recálculo del scoring engine (Requisito 11.5: ≤3s).
 */
function handleAcousticReport(
  socket: WebSocket,
  payload: unknown,
  db: Database.Database,
  onAcousticReport?: (report: ResolvedAcousticReport) => void,
): void {
  const { valid, report, error } = validateAcousticReport(payload);

  if (!valid || !report) {
    sendMessage(socket, SYNC_ACOUSTIC_ACK_TOPIC, { acknowledged: false, id: null, error });
    return;
  }

  const zoneId = resolveZoneForCoordinates(db, report.lat, report.lon);

  if (zoneId === null) {
    sendMessage(socket, SYNC_ACOUSTIC_ACK_TOPIC, {
      acknowledged: false,
      id: report.id,
      error: 'No se encontró una zona registrada cerca de las coordenadas reportadas',
    });
    return;
  }

  storeAcousticReport(db, zoneId, report);

  sendMessage(socket, SYNC_ACOUSTIC_ACK_TOPIC, { acknowledged: true, id: report.id, zone_id: zoneId });

  onAcousticReport?.({ ...report, zone_id: zoneId });
}

/**
 * Retransmite un mensaje CSI del broker MQTT a todos los clientes móviles conectados.
 */
function relayCsiToClients(
  topic: string,
  payload: Buffer,
  clients: Set<WebSocket>,
): void {
  if (clients.size === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf-8'));
  } catch {
    // Payload inválido, no retransmitir
    return;
  }

  const outgoing: RelayOutgoingMessage = {
    type: topic,
    payload: parsed,
  };

  const messageStr = JSON.stringify(outgoing);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

// --- Utilidades de envío ---

/**
 * Envía un mensaje estructurado al cliente.
 */
function sendMessage(socket: WebSocket, type: string, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;

  const message: RelayOutgoingMessage = { type, payload };
  socket.send(JSON.stringify(message));
}

/**
 * Envía un mensaje de error al cliente.
 */
function sendError(socket: WebSocket, reason: string): void {
  sendMessage(socket, 'error', { reason });
}
