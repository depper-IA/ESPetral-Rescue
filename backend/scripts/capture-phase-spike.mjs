#!/usr/bin/env node
/**
 * ESPetral Rescue — Captura de spike de fase CSI a archivo NDJSON
 * (Fase 0, gate de validación csi-vitals-per-node).
 *
 * Se suscribe al broker MQTT local como cliente PSK y vuelca cada
 * mensaje recibido en `cali/zone/{zone_id}/csi_phase_spike` como una
 * línea NDJSON en el archivo de salida — el formato exacto que espera
 * `backend/scripts/analyze-phase-spike.mjs`.
 *
 * Requiere un token PSK ya registrado en `device_tokens` (el mismo
 * token del nodo ESP32 sirve — no hace falta uno nuevo, ver
 * `backend/register-node-token.cjs`). El token NUNCA se hardcodea:
 * se lee de `--token` o de la variable de entorno CALI_MQTT_TOKEN
 * (regla 4.3 de REGLAS_IMPORTANTES.md).
 *
 * Uso:
 *   node backend/scripts/capture-phase-spike.mjs \
 *     --out captura-b-12bpm.ndjson \
 *     --duration 200 \
 *     --token "$CALI_MQTT_TOKEN"
 *
 * Opciones:
 *   --out       Ruta del archivo NDJSON de salida (obligatorio)
 *   --duration  Duración de la captura en segundos (default: 200 — cubre
 *               los 3 minutos pedidos por el spec con margen)
 *   --token     Token PSK. Si se omite, usa CALI_MQTT_TOKEN del entorno
 *   --host      Host del broker MQTT (default: 127.0.0.1)
 *   --port      Puerto TCP del broker MQTT (default: 1883)
 *   --topic     Filtro de tópico (default: cali/zone/+/csi_phase_spike)
 *
 * Repetir una vez por sesión: sala vacía, metrónomo 12 BPM, metrónomo
 * 20 BPM (tareas 0.8, 0.9, 0.10 de sdd/csi-vitals-per-node/tasks).
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import mqtt from 'mqtt';

const DEFAULT_TOPIC = 'cali/zone/+/csi_phase_spike';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 1883;
const DEFAULT_DURATION_SECONDS = 200;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const outPath = args.out;
  if (!outPath) {
    console.error('Falta --out <archivo.ndjson>');
    console.error(
      'Uso: node capture-phase-spike.mjs --out captura.ndjson [--duration 200] [--token ...] [--host 127.0.0.1] [--port 1883] [--topic cali/zone/+/csi_phase_spike]'
    );
    process.exit(1);
  }

  const token = args.token || process.env.CALI_MQTT_TOKEN;
  if (!token) {
    console.error(
      'Falta el token PSK: pasalo con --token o exportá CALI_MQTT_TOKEN. ' +
        'Es el mismo token registrado para el nodo ESP32 (ver backend/register-node-token.cjs).'
    );
    process.exit(1);
  }

  const host = args.host || DEFAULT_HOST;
  const port = Number(args.port || DEFAULT_PORT);
  const topic = args.topic || DEFAULT_TOPIC;
  const durationSeconds = Number(args.duration || DEFAULT_DURATION_SECONDS);

  // Archivo vacío al empezar — cada captura es una sesión nueva, no un append acumulativo.
  writeFileSync(outPath, '');

  let messageCount = 0;

  const client = mqtt.connect(`mqtt://${host}:${port}`, {
    username: 'phase-spike-capture',
    password: token,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
  });

  const finish = (exitCode) => {
    client.end(true, () => {
      console.log(`Captura finalizada: ${messageCount} mensajes escritos en ${outPath}`);
      process.exit(exitCode);
    });
  };

  client.on('connect', () => {
    console.log(`Conectado a mqtt://${host}:${port} — suscribiendo a '${topic}'`);
    client.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        console.error('Error al suscribir:', err.message);
        finish(1);
        return;
      }
      console.log(
        `Capturando durante ${durationSeconds}s. Colocá el nodo según PlacementChecklist y no lo muevas.`
      );
    });
  });

  client.on('message', (_receivedTopic, payload) => {
    try {
      // Validar que sea JSON antes de escribir — evita corromper el NDJSON
      // si llega un mensaje inesperado en un tópico con wildcard.
      JSON.parse(payload.toString('utf-8'));
      appendFileSync(outPath, payload.toString('utf-8') + '\n');
      messageCount++;
    } catch {
      console.warn('Mensaje descartado (JSON inválido)');
    }
  });

  client.on('error', (err) => {
    console.error('Error de conexión MQTT:', err.message);
    finish(1);
  });

  setTimeout(() => finish(0), durationSeconds * 1000);

  process.on('SIGINT', () => {
    console.log('\nInterrumpido por el usuario.');
    finish(0);
  });
}

main();
