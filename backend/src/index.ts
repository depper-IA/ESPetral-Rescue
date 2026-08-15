/**
 * ESPetral Rescue — Punto de entrada del backend
 *
 * Inicializa todos los componentes del sistema:
 * - Base de datos SQLite con SQLCipher
 * - Broker MQTT (Aedes) en puertos 1883 (MQTT nativo) y 9003 (WebSocket MQTT crudo, reservado)
 * - Anuncio mDNS del broker MQTT como cali-backend.local (ver mdns-announcer.ts)
 * - Motor de puntuación compuesta
 * - WebSocket relay JSON para apps móviles (puerto 9001, según design.md)
 * - Servidor Express con dashboard en puerto 3000
 * - Suscripción MQTT → dashboard para actualizaciones en tiempo real
 *
 * Variables de entorno soportadas:
 *   CALI_DB_KEY      — Clave de cifrado para SQLCipher (opcional)
 *   CALI_HTTP_PORT   — Puerto del dashboard (por defecto: 3000)
 *   CALI_MQTT_TOKEN  — Token interno para suscripción del relay MQTT
 */

import { initializeDatabase } from './database.js';
import { createMqttBroker, DEFAULT_MQTT_PORT } from './mqtt-broker.js';
import { createDashboardServer } from './server.js';
import { createWsRelay } from './ws-relay.js';
import { ScoringEngine } from './scoring-engine.js';
import { validateCsiPayload, validateCsiRawFrame } from './mqtt-broker.js';
import { startMdnsAnnouncer } from './mdns-announcer.js';

const HTTP_PORT = parseInt(process.env.CALI_HTTP_PORT || '3000', 10);
const DB_KEY = process.env.CALI_DB_KEY;
const MQTT_TOKEN = process.env.CALI_MQTT_TOKEN || 'internal-relay-token';

async function main() {
  console.log('[espetral] Iniciando ESPetral Rescue...');

  // 1. Inicializar base de datos
  const db = initializeDatabase({
    encryptionKey: DB_KEY,
    enablePurge: true,
  });
  console.log('[cali] Base de datos inicializada');

  // 2. Crear set de tokens internos (incluye token del relay)
  const internalTokens = new Set<string>([MQTT_TOKEN]);

  // 3. Inicializar broker MQTT
  const broker = createMqttBroker({ tokens: internalTokens, db });
  await broker.ready;
  console.log('[cali] Broker MQTT iniciado');

  // 3.1. Anunciar el broker MQTT via mDNS con hostname estable (cali-backend.local)
  // Elimina la dependencia de una IP fija: los nodos ESP32 resuelven el backend
  // por nombre aunque la laptop cambie de red o de IP entre despliegues de campo.
  const mdnsAnnouncer = startMdnsAnnouncer(DEFAULT_MQTT_PORT);

  // 4. Inicializar motor de puntuación
  const scoringEngine = new ScoringEngine({ db, broker });

  // 5. Inicializar servidor del dashboard
  const server = createDashboardServer({ db, port: HTTP_PORT });
  await server.start();

  // 6. Suscribirse a tópicos MQTT para retransmitir a clientes del dashboard
  // Cuando llega telemetría CSI al broker, se reenvía al dashboard vía WebSocket
  broker.aedes.on('publish', (packet, _client) => {
    // Filtrar mensajes CSI: cali/zone/{zone_id}/csi
    const csiMatch = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/csi$/.exec(packet.topic);
    if (csiMatch) {
      const payload = validateCsiPayload(packet.payload);
      if (payload) {
        // Reenviar al dashboard dentro de 1 segundo (inmediato), incluir node_id
        server.broadcastCsiUpdate(payload.zone_id, payload.motion_probability, payload.node_id, payload.rssi);

        // Persistir lectura CSI y recalcular puntuación
        try {
          db.prepare(
            `INSERT OR IGNORE INTO csi_readings (zone_id, node_id, motion_probability, captured_at)
             VALUES (?, ?, ?, ?)`
          ).run(payload.zone_id, payload.node_id, payload.motion_probability, payload.timestamp);

          scoringEngine.computeAndPublish(payload.zone_id);
        } catch (err) {
          console.error('[cali] Error al persistir lectura CSI:', err);
        }
      }
    }

    // Filtrar mensajes CSI raw: cali/zone/{zone_id}/csi_raw
    // El firmware publica las 64 amplitudes de subportadora a ~1 Hz para que
    // pipelines RuView (bandpass breathing/HR, ML presence/pose) operen sobre
    // datos crudos, no solo sobre motion_probability agregada.
    // No persistimos en SQLite: 64 floats × 1 Hz × N nodos = mucho volumen.
    // La función del backend es solo retransmitir al dashboard vía WS.
    const rawMatch = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/csi_raw$/.exec(packet.topic);
    if (rawMatch) {
      const rawPayload = validateCsiRawFrame(packet.payload);
      if (rawPayload) {
        server.broadcastCsiRawUpdate(
          rawPayload.zone_id,
          rawPayload.node_id,
          rawPayload.subcarrier_amplitudes,
          rawPayload.timestamp,
        );
      }
    }

    // Filtrar mensajes de estado de nodos: cali/zone/{zone_id}/status (LWT)
    const statusMatch = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/status$/.exec(packet.topic);
    if (statusMatch) {
      try {
        const statusPayload = JSON.parse(
          Buffer.isBuffer(packet.payload) ? packet.payload.toString('utf-8') : String(packet.payload)
        );
        if (statusPayload.node_id && statusPayload.zone_id && statusPayload.status) {
          // Retransmitir estado del nodo al dashboard
          server.broadcastNodeStatus(
            statusPayload.node_id,
            statusPayload.zone_id,
            statusPayload.status
          );
        }
      } catch {
        // Mensaje de estado no es JSON válido — ignorar silenciosamente
      }
    }

    // Filtrar actualizaciones de score compuesto: cali/zone/{zone_id}/probability
    // Publicado por ScoringEngine tras cada recálculo (CSI, acústico o GPS).
    // Reenviar al dashboard para que el marcador de zona refleje el score
    // compuesto (no solo el motion_probability crudo de CSI).
    const probabilityMatch = /^cali\/zone\/([a-zA-Z0-9_-]{1,64})\/probability$/.exec(packet.topic);
    if (probabilityMatch) {
      try {
        const probabilityPayload = JSON.parse(
          Buffer.isBuffer(packet.payload) ? packet.payload.toString('utf-8') : String(packet.payload)
        );
        if (probabilityPayload.zone_id && typeof probabilityPayload.probability === 'number') {
          server.broadcastProbabilityUpdate(
            probabilityPayload.zone_id,
            probabilityPayload.probability,
            probabilityPayload.sources,
          );
        }
      } catch {
        // Mensaje de probabilidad no es JSON válido — ignorar silenciosamente
      }
    }
  });

  // 7. Inicializar WebSocket relay para apps móviles con callbacks de campo y acústicos
  const relay = createWsRelay({
    db,
    mqttToken: MQTT_TOKEN,
    onFieldReport: (entry) => {
      // Cuando se almacena una ubicación desde la app móvil, notificar al dashboard
      server.broadcastFieldReport(entry);
    },
    onAcousticReport: (report) => {
      // Reporte acústico almacenado: recalcular y publicar el score de la zona
      // resuelta (Requisito 11.5: actualización dentro de 3 segundos)
      scoringEngine.computeAndPublish(report.zone_id);
    },
  });
  console.log('[cali] WebSocket relay para apps móviles iniciado');

  // Apagado limpio
  const shutdown = async () => {
    console.log('\n[cali] Apagando servidor...');
    await mdnsAnnouncer.stop();
    await relay.close();
    await server.stop();
    await broker.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[cali] Error fatal al iniciar:', err);
  process.exit(1);
});
