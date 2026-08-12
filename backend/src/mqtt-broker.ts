/**
 * ESPetral Rescue — Broker MQTT con autenticación PSK y validación de mensajes
 *
 * Configura Aedes en puerto 1883 (MQTT nativo) y 9003 (WebSocket MQTT crudo).
 * El puerto WebSocket de Aedes está reservado para futuros clientes MQTT-sobre-WS
 * en navegador: hoy ningún cliente real lo usa (los ESP32 se conectan por
 * MQTT+TLS en 8883, y la app móvil usa el protocolo JSON del relay en
 * `ws-relay.ts`, puerto 9001, según design.md).
 * Implementa autenticación por token pre-compartido, validación de esquema JSON
 * en mensajes CSI, rechazo de payloads >1KB, keep-alive de 60s con desconexión
 * a los 90s (1.5x), y Last Will and Testament para mensajes de estado offline.
 *
 * Requisitos: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import Aedes, { type Client, type AuthenticateError, type PublishPacket } from 'aedes';
import { createServer, type Server as NetServer } from 'net';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type Database from 'better-sqlite3';
import type { CsiTelemetryMessage, CsiRawFrameMessage } from './types.js';

// --- Constantes de configuración por defecto ---

/** Puerto por defecto para conexiones MQTT TCP */
export const DEFAULT_MQTT_PORT = 1883;

/**
 * Puerto por defecto para conexiones WebSocket MQTT crudo de Aedes.
 * Distinto de 9001 (relay JSON de apps móviles en `ws-relay.ts`) para evitar
 * colisión de puertos — ver comentario del encabezado del archivo.
 */
export const DEFAULT_WS_PORT = 9003;

/** Tamaño máximo de payload en bytes (1KB) */
export const MAX_PAYLOAD_BYTES = 1024;

/** Intervalo de keep-alive en segundos */
export const KEEP_ALIVE_SECONDS = 60;

/**
 * Multiplicador de keep-alive para desconexión (1.5x = 90s con keep-alive de 60s).
 * El broker desconecta al cliente si no recibe PINGREQ dentro de
 * KEEP_ALIVE_SECONDS * KEEP_ALIVE_LIMIT segundos.
 */
export const KEEP_ALIVE_LIMIT = 1.5;

/** Máximo de conexiones simultáneas */
export const MAX_CONNECTIONS = 20;

/** Patrón de topic para telemetría CSI */
const CSI_TOPIC_PATTERN = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/csi$/;

/** Patrón de topic para telemetría CSI cruda (64 amplitudes por trama) */
const CSI_RAW_TOPIC_PATTERN = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/csi_raw$/;

/** Patrón de topic para estado de nodos */
const STATUS_TOPIC_PATTERN = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/status$/;

// --- Validación de mensajes CSI ---

/**
 * Valida que un payload JSON cumple con el esquema CsiTelemetryMessage.
 * Acepta tanto string como Buffer.
 * Retorna el mensaje parseado si es válido, o null si no.
 */
export function validateCsiPayload(payload: string | Buffer): CsiTelemetryMessage | null {
  const raw = typeof payload === 'string' ? payload : payload.toString('utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;

  // Validar campo zone_id: string, 1-64 caracteres
  if (typeof msg.zone_id !== 'string' || msg.zone_id.length < 1 || msg.zone_id.length > 64) {
    return null;
  }

  // Validar campo node_id: string, 1-64 caracteres
  if (typeof msg.node_id !== 'string' || msg.node_id.length < 1 || msg.node_id.length > 64) {
    return null;
  }

  // Validar campo timestamp: string en formato ISO 8601
  if (typeof msg.timestamp !== 'string' || !isValidIso8601(msg.timestamp)) {
    return null;
  }

  // Validar campo motion_probability: número entre 0.0 y 1.0 inclusive
  if (
    typeof msg.motion_probability !== 'number' ||
    !Number.isFinite(msg.motion_probability) ||
    msg.motion_probability < 0.0 ||
    msg.motion_probability > 1.0
  ) {
    return null;
  }

  return {
    zone_id: msg.zone_id,
    node_id: msg.node_id,
    timestamp: msg.timestamp,
    motion_probability: msg.motion_probability,
  };
}

/**
 * Valida que un payload JSON cumple con el esquema CsiRawFrameMessage.
 * Esquema: { zone_id, node_id, timestamp, subcarrier_amplitudes: number[64] }.
 *
 * Cada elemento del array debe ser un número finito (no NaN, no Infinity):
 * `sqrtf(i² + q²)` en el firmware siempre produce valores reales, pero
 * defendemos contra payloads corruptos antes de reenviar al dashboard.
 *
 * Acepta tanto string como Buffer. Retorna el mensaje parseado si es válido,
 * o null si no.
 */
export function validateCsiRawFrame(payload: string | Buffer): CsiRawFrameMessage | null {
  const raw = typeof payload === 'string' ? payload : payload.toString('utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;

  // Validar campo zone_id: string, 1-64 caracteres
  if (typeof msg.zone_id !== 'string' || msg.zone_id.length < 1 || msg.zone_id.length > 64) {
    return null;
  }

  // Validar campo node_id: string, 1-64 caracteres
  if (typeof msg.node_id !== 'string' || msg.node_id.length < 1 || msg.node_id.length > 64) {
    return null;
  }

  // Validar campo timestamp: string en formato ISO 8601
  if (typeof msg.timestamp !== 'string' || !isValidIso8601(msg.timestamp)) {
    return null;
  }

  // Validar campo subcarrier_amplitudes: array de exactamente 64 números finitos.
  // El firmware publica siempre 64 amplitudes (constante CSI_NUM_SUBCARRIERS=64
  // en firmware/main/csi_engine.h). Rechazar longitudes distintas evita que el
  // dashboard asuma shape incorrecto al renderizar.
  if (!Array.isArray(msg.subcarrier_amplitudes) || msg.subcarrier_amplitudes.length !== 64) {
    return null;
  }

  for (const amp of msg.subcarrier_amplitudes) {
    if (typeof amp !== 'number' || !Number.isFinite(amp)) {
      return null;
    }
  }

  return {
    zone_id: msg.zone_id,
    node_id: msg.node_id,
    timestamp: msg.timestamp,
    subcarrier_amplitudes: msg.subcarrier_amplitudes,
  };
}

/**
 * Verifica si un string es un timestamp ISO 8601 válido.
 * Acepta formatos como: 2024-01-15T10:30:00Z, 2024-01-15T10:30:00.000Z,
 * 2024-01-15T10:30:00+05:00
 */
export function isValidIso8601(value: string): boolean {
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  if (!iso8601Regex.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !isNaN(date.getTime());
}

// --- Last Will and Testament helpers ---

/**
 * Genera el tópico de Last Will para un nodo en una zona.
 */
export function buildLastWillTopic(zoneId: string): string {
  return `cali/zone/${zoneId}/status`;
}

/**
 * Genera el payload JSON de Last Will para un nodo ESP32.
 * Se usa al registrar la conexión del nodo para que el broker publique
 * automáticamente un mensaje de "offline" si el nodo se desconecta.
 */
export function buildLastWillPayload(nodeId: string, zoneId: string): string {
  return JSON.stringify({
    node_id: nodeId,
    zone_id: zoneId,
    status: 'offline',
    timestamp: new Date().toISOString(),
  });
}

// --- Opciones de configuración del broker ---

export interface MqttBrokerOptions {
  /** Puerto TCP para MQTT (default: 1883) */
  mqttPort?: number;
  /** Puerto HTTP para WebSocket MQTT crudo (default: 9003, reservado) */
  wsPort?: number;
  /**
   * Set de tokens válidos para autenticación PSK.
   * Uso directo: útil para pruebas o cuando los tokens ya se cargaron en memoria.
   */
  tokens?: Set<string>;
  /**
   * Instancia de base de datos para validar tokens contra la tabla device_tokens.
   * Si se proporciona, tiene prioridad sobre el Set de tokens estático.
   * Valida que el token exista y no esté revocado.
   */
  db?: Database.Database;
}

// --- Interfaz del broker ---

export interface MqttBrokerInstance {
  /** Instancia de Aedes */
  aedes: Aedes;
  /** Servidor TCP para conexiones MQTT nativas */
  tcpServer: NetServer;
  /** Servidor HTTP para WebSocket */
  httpServer: HttpServer;
  /** Servidor WebSocket */
  wsServer: WebSocketServer;
  /** Resolves when both TCP and WebSocket servers are listening */
  ready: Promise<void>;
  /** Detiene todos los servidores y cierra conexiones */
  close(): Promise<void>;
}

/**
 * Crea y configura la instancia del broker MQTT con todas las funcionalidades:
 * - Autenticación PSK
 * - Validación de payloads (tamaño y esquema JSON)
 * - Keep-alive y timeout de desconexión
 * - Last Will and Testament
 * - Soporte para 20+ conexiones simultáneas
 *
 * El broker se inicia inmediatamente al ser creado.
 */
export function createMqttBroker(options: MqttBrokerOptions = {}): MqttBrokerInstance {
  const {
    mqttPort = DEFAULT_MQTT_PORT,
    wsPort = DEFAULT_WS_PORT,
    tokens = new Set<string>(),
    db,
  } = options;

  // Crear instancia de Aedes con configuración de conexiones y keep-alive.
  //
  // Nota: Aedes aplica automáticamente el multiplicador 1.5x sobre el keep-alive
  // declarado por el cliente (especificación MQTT [MQTT-3.1.2-24]), por lo que
  // NO usamos `keepaliveLimit` — esa opción limita el valor MÁXIMO permitido
  // (un cliente con keepalive=60 sería rechazado porque 60 > cualquier valor
  // pequeño). El default 0 (sin límite) respeta a todos los clientes ESP32/mqtt.js.
  const aedes = new Aedes({
    concurrency: MAX_CONNECTIONS * 10,
    heartbeatInterval: 30_000,
    connectTimeout: 30_000,
  });

  // --- Autenticación PSK ---
  aedes.authenticate = (
    _client: Client,
    _username: string | undefined,
    password: Buffer | undefined,
    callback
  ) => {
    // El token se envía como password en el paquete CONNECT
    const token = password?.toString('utf-8');

    if (!token) {
      const error = new Error('Autenticación fallida: token no proporcionado') as AuthenticateError;
      error.returnCode = 4;
      callback(error, false);
      return;
    }

    // Validación contra base de datos (prioridad si disponible)
    if (db) {
      try {
        const row = db.prepare(
          `SELECT token, revoked FROM device_tokens WHERE token = ?`
        ).get(token) as { token: string; revoked: number } | undefined;

        if (!row || row.revoked === 1) {
          const error = new Error('Autenticación fallida: token inválido o revocado') as AuthenticateError;
          error.returnCode = 4;
          callback(error, false);
          return;
        }

        // Actualizar last_seen_at del token
        db.prepare(
          `UPDATE device_tokens SET last_seen_at = datetime('now') WHERE token = ?`
        ).run(token);

        callback(null, true);
      } catch (err) {
        const error = new Error('Error interno de autenticación') as AuthenticateError;
        error.returnCode = 3; // Server unavailable
        callback(error, false);
      }
      return;
    }

    // Validación con Set estático (fallback para pruebas)
    if (!tokens.has(token)) {
      const error = new Error('Autenticación fallida: token inválido') as AuthenticateError;
      error.returnCode = 4;
      callback(error, false);
      return;
    }

    callback(null, true);
  };

  // --- Validación de mensajes publicados ---
  aedes.authorizePublish = (_client: Client | null, packet: PublishPacket, callback) => {
    // Rechazar payloads que excedan 1KB
    if (packet.payload && Buffer.byteLength(packet.payload) > MAX_PAYLOAD_BYTES) {
      const error = new Error('Payload excede tamaño máximo de 1KB');
      callback(error);
      return;
    }

    // Validar esquema JSON en topics CSI
    const csiMatch = CSI_TOPIC_PATTERN.exec(packet.topic);
    if (csiMatch) {
      const payloadStr = Buffer.isBuffer(packet.payload)
        ? packet.payload.toString('utf-8')
        : packet.payload.toString();

      const validatedMsg = validateCsiPayload(payloadStr);
      if (!validatedMsg) {
        const error = new Error('Mensaje CSI inválido: esquema JSON no cumple con los requisitos');
        callback(error);
        return;
      }

      // Verificar que el zone_id del topic coincide con el del payload
      const topicZoneId = csiMatch[1];
      if (validatedMsg.zone_id !== topicZoneId) {
        const error = new Error('zone_id del payload no coincide con el topic');
        callback(error);
        return;
      }
    }

    // Validar esquema JSON en topics CSI raw (64 amplitudes de subportadora)
    const csiRawMatch = CSI_RAW_TOPIC_PATTERN.exec(packet.topic);
    if (csiRawMatch) {
      const payloadStr = Buffer.isBuffer(packet.payload)
        ? packet.payload.toString('utf-8')
        : packet.payload.toString();

      const validatedRaw = validateCsiRawFrame(payloadStr);
      if (!validatedRaw) {
        const error = new Error('Mensaje CSI raw inválido: esquema JSON no cumple con los requisitos');
        callback(error);
        return;
      }

      // Verificar que el zone_id del topic coincide con el del payload
      const topicZoneId = csiRawMatch[1];
      if (validatedRaw.zone_id !== topicZoneId) {
        const error = new Error('zone_id del payload csi_raw no coincide con el topic');
        callback(error);
        return;
      }
    }

    // Validar mensajes de estado en topic status
    if (STATUS_TOPIC_PATTERN.test(packet.topic)) {
      try {
        const statusStr = Buffer.isBuffer(packet.payload)
          ? packet.payload.toString('utf-8')
          : packet.payload.toString();
        const statusPayload = JSON.parse(statusStr);
        if (!statusPayload.node_id || !statusPayload.zone_id || !statusPayload.status) {
          const error = new Error('Mensaje de estado incompleto');
          callback(error);
          return;
        }
      } catch {
        const error = new Error('Mensaje de estado no es JSON válido');
        callback(error);
        return;
      }
    }

    callback(null);
  };

  // --- Logging de eventos ---
  aedes.on('client', (client: Client) => {
    console.log(`[MQTT] Cliente conectado: ${client.id}`);
  });

  aedes.on('clientDisconnect', (client: Client) => {
    console.log(`[MQTT] Cliente desconectado: ${client.id}`);
  });

  aedes.on('keepaliveTimeout', (client: Client) => {
    console.log(`[MQTT] Keep-alive timeout (>${KEEP_ALIVE_SECONDS * KEEP_ALIVE_LIMIT}s sin PINGREQ): ${client.id}`);
  });

  aedes.on('clientError', (client: Client, err: Error) => {
    console.error(`[MQTT] Error en cliente ${client.id}:`, err.message);
  });

  // --- Configurar servidores ---

  // Servidor TCP para conexiones MQTT nativas
  const tcpServer = createServer(aedes.handle);
  const tcpReady = new Promise<void>((resolve) => {
    tcpServer.listen(mqttPort, () => {
      console.log(`[MQTT] Servidor TCP escuchando en puerto ${mqttPort}`);
      resolve();
    });
  });

  // Servidor HTTP + WebSocket para conexiones desde navegadores
  const httpServer = createHttpServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  // Conectar WebSocket al broker Aedes
  wsServer.on('connection', (socket) => {
    const stream = createWebSocketStream(socket);
    aedes.handle(stream as unknown as Parameters<typeof aedes.handle>[0]);
  });

  const httpReady = new Promise<void>((resolve) => {
    httpServer.listen(wsPort, () => {
      console.log(`[MQTT] Servidor WebSocket escuchando en puerto ${wsPort}`);
      resolve();
    });
  });

  // Promise that resolves when both servers are listening
  const ready = Promise.all([tcpReady, httpReady]).then(() => {});

  // --- Método de cierre ---
  async function close(): Promise<void> {
    return new Promise((resolve) => {
      aedes.close(() => {
        tcpServer.close(() => {
          httpServer.close(() => {
            resolve();
          });
        });
      });
    });
  }

  return {
    aedes,
    tcpServer,
    httpServer,
    wsServer,
    ready,
    close,
  };
}
