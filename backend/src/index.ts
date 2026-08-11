/**
 * CALI Rescue System — Punto de entrada del backend
 *
 * Inicializa todos los componentes del sistema:
 * - Base de datos SQLite con SQLCipher
 * - Broker MQTT (Aedes) en puertos 1883 y 9001
 * - Motor de puntuación compuesta
 * - WebSocket relay para apps móviles (puerto 9002)
 * - Servidor Express con dashboard en puerto 3000
 * - Suscripción MQTT → dashboard para actualizaciones en tiempo real
 *
 * Variables de entorno soportadas:
 *   CALI_DB_KEY      — Clave de cifrado para SQLCipher (opcional)
 *   CALI_HTTP_PORT   — Puerto del dashboard (por defecto: 3000)
 *   CALI_MQTT_TOKEN  — Token interno para suscripción del relay MQTT
 */

import { initializeDatabase } from './database.js';
import { createMqttBroker } from './mqtt-broker.js';
import { createDashboardServer } from './server.js';
import { createWsRelay } from './ws-relay.js';
import { ScoringEngine } from './scoring-engine.js';
import { validateCsiPayload } from './mqtt-broker.js';

const HTTP_PORT = parseInt(process.env.CALI_HTTP_PORT || '3000', 10);
const DB_KEY = process.env.CALI_DB_KEY;
const MQTT_TOKEN = process.env.CALI_MQTT_TOKEN || 'internal-relay-token';

async function main() {
  console.log('[cali] Iniciando CALI Rescue System...');

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
  console.log('[cali] Broker MQTT iniciado');

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
        server.broadcastCsiUpdate(payload.zone_id, payload.motion_probability, payload.node_id);

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
  });

  // 7. Inicializar WebSocket relay para apps móviles con callback de campo
  const relay = createWsRelay({
    db,
    mqttToken: MQTT_TOKEN,
    onFieldReport: (entry) => {
      // Cuando se almacena una ubicación desde la app móvil, notificar al dashboard
      server.broadcastFieldReport(entry);
    },
  });
  console.log('[cali] WebSocket relay para apps móviles iniciado');

  // Apagado limpio
  const shutdown = async () => {
    console.log('\n[cali] Apagando servidor...');
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
