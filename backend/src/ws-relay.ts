/**
 * CALI Rescue System — WebSocket Relay para conexiones de apps móviles
 *
 * Servidor WebSocket en puerto 9002 que conecta apps móviles al broker MQTT.
 * Protocolo JSON (no MQTT) para sincronización de ubicaciones y retransmisión
 * de alertas CSI a clientes móviles suscritos.
 *
 * Funcionalidades:
 * - Recibe batches de ubicación (`cali/sync/entries`), valida, deduplica y almacena en SQLite
 * - Envía acknowledgments (`cali/sync/ack`) con IDs confirmados
 * - Retransmite mensajes `cali/zone/+/csi` a clientes móviles suscritos
 *
 * Requisitos: 8.1, 8.2, 13.1, 13.2
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import type Database from 'better-sqlite3';
import type Aedes from 'aedes';
import mqtt from 'mqtt';
import type { LocationSyncBatch, LocationSyncAck, LocationEntry } from './types.js';

// --- Constantes ---

/** Puerto por defecto para el relay WebSocket de apps móviles */
export const DEFAULT_RELAY_PORT = 9002;

/** Máximo de entradas por batch de sincronización */
export const MAX_BATCH_SIZE = 50;

/** Tópico para sincronización de ubicaciones (entrada) */
const SYNC_ENTRIES_TOPIC = 'cali/sync/entries';

/** Tópico para acknowledgment de sincronización (salida) */
const SYNC_ACK_TOPIC = 'cali/sync/ack';

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

// --- Opciones de configuración ---

export interface WsRelayOptions {
  /** Puerto HTTP para el servidor WebSocket (default: 9002) */
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

// --- Creación del relay ---

/**
 * Crea y configura el servidor WebSocket relay para apps móviles.
 *
 * El relay:
 * 1. Escucha en el puerto configurado (default 9002) conexiones WebSocket JSON
 * 2. Procesa mensajes `cali/sync/entries`: valida, deduplica, almacena y responde con ack
 * 3. Se suscribe internamente al broker MQTT en `cali/zone/+/csi`
 * 4. Retransmite mensajes CSI a todos los clientes móviles conectados
 */
export function createWsRelay(options: WsRelayOptions): WsRelayInstance {
  const {
    port = DEFAULT_RELAY_PORT,
    db,
    mqttUrl = 'mqtt://localhost:1883',
    mqttToken,
    validTokens = new Set<string>(),
    onFieldReport,
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
      handleClientMessage(socket, data, db, onFieldReport);
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
      mqttOptions.password = mqttToken;
    }

    mqttClient = mqtt.connect(mqttUrl, mqttOptions);

    mqttClient.on('connect', () => {
      console.log('[ws-relay] Conectado al broker MQTT para retransmisión CSI');
      mqttClient!.subscribe('cali/zone/+/csi', (err) => {
        if (err) {
          console.error('[ws-relay] Error al suscribirse a tópicos CSI:', err.message);
        }
      });
    });

    mqttClient.on('message', (topic: string, payload: Buffer) => {
      // Retransmitir mensajes CSI a todos los clientes móviles conectados
      if (topic.startsWith(CSI_TOPIC_PREFIX) && topic.endsWith(CSI_TOPIC_SUFFIX)) {
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
