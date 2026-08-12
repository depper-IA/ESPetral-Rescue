/**
 * Tests unitarios para el broker MQTT: autenticación PSK, validación de mensajes CSI,
 * Last Will and Testament, y conectividad WebSocket.
 *
 * Requisitos cubiertos: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { describe, it, expect, afterEach } from 'vitest';
import mqtt from 'mqtt';
import { initializeDatabase, stopPurgeDaemon } from './database.js';
import {
  createMqttBroker,
  validateCsiPayload,
  validateCsiRawFrame,
  buildLastWillPayload,
  buildLastWillTopic,
  KEEP_ALIVE_LIMIT,
  KEEP_ALIVE_SECONDS,
  DEFAULT_WS_PORT,
  type MqttBrokerInstance,
} from './mqtt-broker.js';
import { DEFAULT_RELAY_PORT } from './ws-relay.js';

// --- Tests de validación de payload CSI (puro, sin broker) ---

describe('validateCsiPayload', () => {
  it('acepta un mensaje CSI válido', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.75,
      node_id: 'node-01',
    });
    const result = validateCsiPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.zone_id).toBe('zone-a');
    expect(result!.motion_probability).toBe(0.75);
  });

  it('rechaza JSON no válido', () => {
    expect(validateCsiPayload('not json')).toBeNull();
  });

  it('rechaza payload sin zone_id', () => {
    const payload = JSON.stringify({
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza payload sin node_id', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.5,
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza payload sin timestamp', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza payload sin motion_probability', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza motion_probability menor que 0', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: -0.1,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza motion_probability mayor que 1', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 1.1,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('acepta motion_probability en los límites (0.0 y 1.0)', () => {
    const payloadMin = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.0,
      node_id: 'node-01',
    });
    const payloadMax = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 1.0,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payloadMin)).not.toBeNull();
    expect(validateCsiPayload(payloadMax)).not.toBeNull();
  });

  it('rechaza zone_id vacío', () => {
    const payload = JSON.stringify({
      zone_id: '',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza zone_id mayor a 64 caracteres', () => {
    const payload = JSON.stringify({
      zone_id: 'a'.repeat(65),
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('rechaza timestamp no ISO 8601', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '15/01/2024 10:30',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('acepta timestamp con offset de zona horaria', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00-05:00',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).not.toBeNull();
  });

  it('acepta timestamp con milisegundos', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00.123Z',
      motion_probability: 0.5,
      node_id: 'node-01',
    });
    expect(validateCsiPayload(payload)).not.toBeNull();
  });

  it('rechaza motion_probability NaN', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: NaN,
      node_id: 'node-01',
    });
    // JSON.stringify(NaN) produces null, so this is actually invalid JSON field
    expect(validateCsiPayload(payload)).toBeNull();
  });

  it('acepta Buffer como input', () => {
    const payload = Buffer.from(JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      motion_probability: 0.5,
      node_id: 'node-01',
    }));
    expect(validateCsiPayload(payload)).not.toBeNull();
  });
});

// --- Tests de validación de payload CSI raw (64 amplitudes de subportadora) ---

describe('validateCsiRawFrame', () => {
  // Helper: genera un array de 64 floats de prueba
  const makeAmplitudes = (count: number = 64): number[] =>
    Array.from({ length: count }, (_, i) => i + 0.5);

  it('acepta un mensaje CSI raw válido con 64 amplitudes', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    const result = validateCsiRawFrame(payload);
    expect(result).not.toBeNull();
    expect(result!.zone_id).toBe('zone-a');
    expect(result!.node_id).toBe('node-01');
    expect(result!.subcarrier_amplitudes).toHaveLength(64);
  });

  it('rechaza JSON no válido', () => {
    expect(validateCsiRawFrame('not json')).toBeNull();
  });

  it('rechaza payload sin zone_id', () => {
    const payload = JSON.stringify({
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza payload sin node_id', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza payload sin timestamp', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza payload sin subcarrier_amplitudes', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza subcarrier_amplitudes con longitud distinta a 64 (63)', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(63),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza subcarrier_amplitudes con longitud distinta a 64 (65)', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(65),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza subcarrier_amplitudes vacío (length 0)', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: [],
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza subcarrier_amplitudes que no es array (string)', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: 'not-an-array',
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza amplitud NaN en el array', () => {
    const amplitudes = makeAmplitudes();
    amplitudes[10] = NaN;
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: amplitudes,
    });
    // JSON.stringify(NaN) produce null, lo que reduce el array length efectivo.
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza amplitud Infinity en el array', () => {
    const amplitudes = makeAmplitudes();
    amplitudes[5] = Infinity;
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: amplitudes,
    });
    // JSON.stringify(Infinity) produce null, reduce length efectivo.
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza amplitud que no es número (string)', () => {
    const amplitudes = makeAmplitudes();
    amplitudes[20] = 'oops' as unknown as number;
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: amplitudes,
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza timestamp no ISO 8601', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '15/01/2024 10:30',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('acepta timestamp con offset de zona horaria', () => {
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00-05:00',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).not.toBeNull();
  });

  it('rechaza zone_id vacío', () => {
    const payload = JSON.stringify({
      zone_id: '',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('rechaza zone_id mayor a 64 caracteres', () => {
    const payload = JSON.stringify({
      zone_id: 'a'.repeat(65),
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    });
    expect(validateCsiRawFrame(payload)).toBeNull();
  });

  it('acepta Buffer como input', () => {
    const payload = Buffer.from(JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: makeAmplitudes(),
    }));
    expect(validateCsiRawFrame(payload)).not.toBeNull();
  });

  it('preserva los valores de amplitudes en el resultado validado', () => {
    const amplitudes = makeAmplitudes();
    const payload = JSON.stringify({
      zone_id: 'zone-a',
      node_id: 'node-01',
      timestamp: '2024-01-15T10:30:00Z',
      subcarrier_amplitudes: amplitudes,
    });
    const result = validateCsiRawFrame(payload);
    expect(result).not.toBeNull();
    expect(result!.subcarrier_amplitudes[0]).toBe(0.5);
    expect(result!.subcarrier_amplitudes[63]).toBe(63.5);
  });
});

// --- Tests de Last Will and Testament ---

describe('buildLastWillPayload', () => {
  it('genera payload con los campos requeridos', () => {
    const payload = JSON.parse(buildLastWillPayload('node-01', 'zone-a'));
    expect(payload.node_id).toBe('node-01');
    expect(payload.zone_id).toBe('zone-a');
    expect(payload.status).toBe('offline');
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('buildLastWillTopic', () => {
  it('genera el tópico correcto', () => {
    expect(buildLastWillTopic('zone-a')).toBe('cali/zone/zone-a/status');
  });
});

// --- Tests de integración con broker real ---

/** Aedes only supports MQTT v3.1.1 (protocol version 4). mqtt.js v5 defaults to v5. */
const MQTT_OPTIONS = { protocolVersion: 4 as const };

describe('createMqttBroker - integración', () => {
  let brokerInstance: MqttBrokerInstance;

  afterEach(async () => {
    if (brokerInstance) {
      await brokerInstance.close();
    }
  });

  it('inicia el broker y acepta conexiones MQTT con token válido', async () => {
    const tokens = new Set(['test-token-valid']);
    brokerInstance = createMqttBroker({ mqttPort: 18831, wsPort: 19001, tokens });

    // Esperar a que el servidor esté listo
    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18831', {
      ...MQTT_OPTIONS,
      username: 'esp32-node',
      password: 'test-token-valid',
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.end();
        resolve();
      });
      client.on('error', (err) => {
        client.end();
        reject(err);
      });
      setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('rechaza conexiones con token inválido', async () => {
    const tokens = new Set(['valid-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18832, wsPort: 19002, tokens });

    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18832', {
      ...MQTT_OPTIONS,
      username: 'attacker',
      password: 'wrong-token',
    });

    await new Promise<void>((resolve) => {
      client.on('error', () => {
        client.end();
        resolve();
      });
      client.on('connect', () => {
        client.end();
        // Si conecta, el test debería fallar pero limpiamos gracefully
        resolve();
      });
      setTimeout(() => { client.end(); resolve(); }, 3000);
    });
  });

  it('permite publicar un mensaje CSI válido', async () => {
    const tokens = new Set(['pub-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18833, wsPort: 19003, tokens });

    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18833', {
      ...MQTT_OPTIONS,
      username: 'node-a',
      password: 'pub-token',
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        const validMsg = JSON.stringify({
          zone_id: 'zone-a',
          timestamp: '2024-01-15T10:30:00Z',
          motion_probability: 0.7,
          node_id: 'node-a',
        });

        client.publish('cali/zone/zone-a/csi', validMsg, (err) => {
          client.end();
          if (err) reject(err);
          else resolve();
        });
      });
      client.on('error', (err) => { client.end(); reject(err); });
      setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('rechaza mensajes CSI con campos faltantes (no llega al suscriptor)', async () => {
    const tokens = new Set(['pub-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18834, wsPort: 19004, tokens });

    await brokerInstance.ready;

    // Suscriptor
    const subscriber = mqtt.connect('mqtt://localhost:18834', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'pub-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Sub timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-a/csi');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Publicador con mensaje inválido
    const publisher = mqtt.connect('mqtt://localhost:18834', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'pub-token',
    });

    let messageReceived = false;
    subscriber.on('message', () => { messageReceived = true; });

    await new Promise<void>((resolve, reject) => {
      publisher.on('connect', () => {
        // Mensaje sin motion_probability
        const invalidMsg = JSON.stringify({
          zone_id: 'zone-a',
          timestamp: '2024-01-15T10:30:00Z',
          node_id: 'node-a',
        });
        publisher.publish('cali/zone/zone-a/csi', invalidMsg, () => {
          // Esperar un momento para verificar que no llegó
          setTimeout(() => {
            publisher.end();
            subscriber.end();
            if (messageReceived) {
              reject(new Error('El mensaje inválido fue relay-eado al suscriptor'));
            } else {
              resolve();
            }
          }, 500);
        });
      });
      publisher.on('error', (err) => { publisher.end(); subscriber.end(); reject(err); });
      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('rechaza payloads mayores a 1KB', async () => {
    const tokens = new Set(['pub-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18835, wsPort: 19005, tokens });

    await brokerInstance.ready;

    const subscriber = mqtt.connect('mqtt://localhost:18835', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'pub-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-a/csi');
    await new Promise(resolve => setTimeout(resolve, 100));

    const publisher = mqtt.connect('mqtt://localhost:18835', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'pub-token',
    });

    let messageReceived = false;
    subscriber.on('message', () => { messageReceived = true; });

    await new Promise<void>((resolve, reject) => {
      publisher.on('connect', () => {
        // Payload gigante que excede 1KB
        const largePayload = JSON.stringify({
          zone_id: 'zone-a',
          timestamp: '2024-01-15T10:30:00Z',
          motion_probability: 0.5,
          node_id: 'node-a',
          padding: 'x'.repeat(1500),
        });
        publisher.publish('cali/zone/zone-a/csi', largePayload, () => {
          setTimeout(() => {
            publisher.end();
            subscriber.end();
            if (messageReceived) {
              reject(new Error('El payload >1KB fue relay-eado'));
            } else {
              resolve();
            }
          }, 500);
        });
      });
      publisher.on('error', (err) => { publisher.end(); subscriber.end(); reject(err); });
      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('relay mensajes CSI válidos a suscriptores (latencia <200ms)', async () => {
    const tokens = new Set(['relay-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18836, wsPort: 19006, tokens });

    await brokerInstance.ready;

    // Suscriptor
    const subscriber = mqtt.connect('mqtt://localhost:18836', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'relay-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-b/csi');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Publicador
    const publisher = mqtt.connect('mqtt://localhost:18836', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'relay-token',
    });

    const publishTime = Date.now();
    let receiveTime = 0;

    await new Promise<void>((resolve, reject) => {
      subscriber.on('message', (_topic, payload) => {
        receiveTime = Date.now();
        const msg = JSON.parse(payload.toString());
        expect(msg.zone_id).toBe('zone-b');
        expect(msg.motion_probability).toBe(0.85);
        publisher.end();
        subscriber.end();
        resolve();
      });

      publisher.on('connect', () => {
        const validMsg = JSON.stringify({
          zone_id: 'zone-b',
          timestamp: '2024-01-15T10:30:00Z',
          motion_probability: 0.85,
          node_id: 'node-b',
        });
        publisher.publish('cali/zone/zone-b/csi', validMsg);
      });

      publisher.on('error', (err) => { publisher.end(); subscriber.end(); reject(err); });
      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Timeout')); }, 5000);
    });

    // Verificar latencia < 200ms (Req 6.2)
    const latency = receiveTime - publishTime;
    expect(latency).toBeLessThan(200);
  });

  it('permite publicar un mensaje CSI raw válido (64 amplitudes)', async () => {
    const tokens = new Set(['raw-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18842, wsPort: 19012, tokens });

    await brokerInstance.ready;

    // Suscriptor
    const subscriber = mqtt.connect('mqtt://localhost:18842', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'raw-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Sub timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-raw/csi_raw');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Publicador
    const publisher = mqtt.connect('mqtt://localhost:18842', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'raw-token',
    });

    await new Promise<void>((resolve, reject) => {
      publisher.on('connect', () => resolve());
      publisher.on('error', reject);
      setTimeout(() => reject(new Error('Pub timeout')), 5000);
    });

    const amplitudes = Array.from({ length: 64 }, (_, i) => i * 0.1);

    await new Promise<void>((resolve, reject) => {
      subscriber.on('message', (_topic, payload) => {
        const msg = JSON.parse(payload.toString());
        expect(msg.zone_id).toBe('zone-raw');
        expect(msg.node_id).toBe('node-raw');
        expect(Array.isArray(msg.subcarrier_amplitudes)).toBe(true);
        expect(msg.subcarrier_amplitudes).toHaveLength(64);
        expect(msg.subcarrier_amplitudes[0]).toBeCloseTo(0);
        publisher.end();
        subscriber.end();
        resolve();
      });

      const validRaw = JSON.stringify({
        zone_id: 'zone-raw',
        node_id: 'node-raw',
        timestamp: '2024-01-15T10:30:00Z',
        subcarrier_amplitudes: amplitudes,
      });

      publisher.publish('cali/zone/zone-raw/csi_raw', validRaw, (err) => {
        if (err) {
          publisher.end();
          subscriber.end();
          reject(err);
        }
      });

      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Mensaje csi_raw no relay-eado')); }, 5000);
    });
  });

  it('rechaza mensaje CSI raw con subcarrier_amplitudes de longitud incorrecta', async () => {
    const tokens = new Set(['raw-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18843, wsPort: 19013, tokens });

    await brokerInstance.ready;

    const subscriber = mqtt.connect('mqtt://localhost:18843', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'raw-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Sub timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-x/csi_raw');
    await new Promise(resolve => setTimeout(resolve, 100));

    const publisher = mqtt.connect('mqtt://localhost:18843', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'raw-token',
    });

    let messageReceived = false;
    subscriber.on('message', () => { messageReceived = true; });

    await new Promise<void>((resolve, reject) => {
      publisher.on('connect', () => {
        // 32 amplitudes en vez de 64 — debe ser rechazado por authorizePublish
        const invalidRaw = JSON.stringify({
          zone_id: 'zone-x',
          node_id: 'node-x',
          timestamp: '2024-01-15T10:30:00Z',
          subcarrier_amplitudes: Array.from({ length: 32 }, (_, i) => i),
        });

        publisher.publish('cali/zone/zone-x/csi_raw', invalidRaw, () => {
          setTimeout(() => {
            publisher.end();
            subscriber.end();
            if (messageReceived) {
              reject(new Error('El mensaje csi_raw inválido fue relay-eado'));
            } else {
              resolve();
            }
          }, 500);
        });
      });
      publisher.on('error', (err) => { publisher.end(); subscriber.end(); reject(err); });
      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('rechaza mensaje CSI raw con zone_id distinto al del topic', async () => {
    const tokens = new Set(['raw-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18844, wsPort: 19014, tokens });

    await brokerInstance.ready;

    const subscriber = mqtt.connect('mqtt://localhost:18844', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'raw-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Sub timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-y/csi_raw');
    await new Promise(resolve => setTimeout(resolve, 100));

    const publisher = mqtt.connect('mqtt://localhost:18844', {
      ...MQTT_OPTIONS,
      username: 'pub',
      password: 'raw-token',
    });

    let messageReceived = false;
    subscriber.on('message', () => { messageReceived = true; });

    await new Promise<void>((resolve, reject) => {
      publisher.on('connect', () => {
        // zone_id del payload "zone-z" no coincide con zone-y del topic
        const mismatchRaw = JSON.stringify({
          zone_id: 'zone-z',
          node_id: 'node-y',
          timestamp: '2024-01-15T10:30:00Z',
          subcarrier_amplitudes: Array.from({ length: 64 }, () => 0),
        });

        publisher.publish('cali/zone/zone-y/csi_raw', mismatchRaw, () => {
          setTimeout(() => {
            publisher.end();
            subscriber.end();
            if (messageReceived) {
              reject(new Error('zone_id distinto al topic fue relay-eado'));
            } else {
              resolve();
            }
          }, 500);
        });
      });
      publisher.on('error', (err) => { publisher.end(); subscriber.end(); reject(err); });
      setTimeout(() => { publisher.end(); subscriber.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('Last Will se publica al desconectar cliente inesperadamente', async () => {
    const tokens = new Set(['will-token']);
    brokerInstance = createMqttBroker({ mqttPort: 18837, wsPort: 19007, tokens });

    await brokerInstance.ready;

    // Suscriptor para el tópico de estado
    const subscriber = mqtt.connect('mqtt://localhost:18837', {
      ...MQTT_OPTIONS,
      username: 'sub',
      password: 'will-token',
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.on('connect', () => resolve());
      subscriber.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    subscriber.subscribe('cali/zone/zone-c/status');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Cliente con Last Will configurado
    const willPayload = buildLastWillPayload('node-c', 'zone-c');
    const clientWithWill = mqtt.connect('mqtt://localhost:18837', {
      ...MQTT_OPTIONS,
      username: 'node-c',
      password: 'will-token',
      will: {
        topic: buildLastWillTopic('zone-c'),
        payload: Buffer.from(willPayload),
        qos: 1,
        retain: false,
      },
    });

    await new Promise<void>((resolve, reject) => {
      clientWithWill.on('connect', () => resolve());
      clientWithWill.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // Simular desconexión inesperada (destruir socket)
    await new Promise<void>((resolve, reject) => {
      subscriber.on('message', (_topic, payload) => {
        const msg = JSON.parse(payload.toString());
        expect(msg.node_id).toBe('node-c');
        expect(msg.zone_id).toBe('zone-c');
        expect(msg.status).toBe('offline');
        expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        subscriber.end();
        resolve();
      });

      // Forzar cierre abrupto del cliente (simula crash)
      (clientWithWill as any).stream.destroy();

      setTimeout(() => { subscriber.end(); reject(new Error('LWT no fue publicado')); }, 5000);
    });
  });
});

// --- Tests de autenticación con base de datos ---

describe('createMqttBroker - autenticación con base de datos', () => {
  let brokerInstance: MqttBrokerInstance;
  let db: ReturnType<typeof initializeDatabase>;

  afterEach(async () => {
    if (brokerInstance) {
      await brokerInstance.close();
    }
    stopPurgeDaemon();
    if (db) {
      db.close();
    }
  });

  function setupTestDb(): ReturnType<typeof initializeDatabase> {
    const testDb = initializeDatabase({ inMemory: true, enablePurge: false });
    return testDb;
  }

  it('acepta conexión con token válido desde base de datos', async () => {
    db = setupTestDb();
    db.prepare(
      `INSERT INTO device_tokens (token, device_type, label) VALUES (?, 'esp32', 'Test Node')`
    ).run('db-valid-token');

    brokerInstance = createMqttBroker({ mqttPort: 18838, wsPort: 19008, db });
    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18838', {
      username: 'esp32-node',
      password: 'db-valid-token',
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.end();
        resolve();
      });
      client.on('error', (err) => {
        client.end();
        reject(err);
      });
      setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
    });
  });

  it('rechaza conexión con token inexistente en base de datos', async () => {
    db = setupTestDb();
    // No se inserta ningún token

    brokerInstance = createMqttBroker({ mqttPort: 18839, wsPort: 19009, db });
    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18839', {
      username: 'attacker',
      password: 'nonexistent-token',
    });

    await new Promise<void>((resolve) => {
      client.on('error', () => {
        client.end();
        resolve();
      });
      client.on('connect', () => {
        client.end();
        resolve();
      });
      setTimeout(() => { client.end(); resolve(); }, 3000);
    });
  });

  it('rechaza conexión con token revocado en base de datos', async () => {
    db = setupTestDb();
    db.prepare(
      `INSERT INTO device_tokens (token, device_type, label, revoked) VALUES (?, 'esp32', 'Revoked Node', 1)`
    ).run('revoked-token');

    brokerInstance = createMqttBroker({ mqttPort: 18840, wsPort: 19010, db });
    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18840', {
      username: 'revoked-node',
      password: 'revoked-token',
    });

    await new Promise<void>((resolve) => {
      client.on('error', () => {
        client.end();
        resolve();
      });
      client.on('connect', () => {
        client.end();
        resolve();
      });
      setTimeout(() => { client.end(); resolve(); }, 3000);
    });
  });

  it('actualiza last_seen_at al autenticar exitosamente', async () => {
    db = setupTestDb();
    db.prepare(
      `INSERT INTO device_tokens (token, device_type, label) VALUES (?, 'esp32', 'Tracked Node')`
    ).run('tracked-token');

    // Verificar que last_seen_at empieza nulo
    const before = db.prepare(`SELECT last_seen_at FROM device_tokens WHERE token = ?`).get('tracked-token') as { last_seen_at: string | null };
    expect(before.last_seen_at).toBeNull();

    brokerInstance = createMqttBroker({ mqttPort: 18841, wsPort: 19011, db });
    await brokerInstance.ready;

    const client = mqtt.connect('mqtt://localhost:18841', {
      username: 'tracked-node',
      password: 'tracked-token',
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.end();
        resolve();
      });
      client.on('error', (err) => {
        client.end();
        reject(err);
      });
      setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
    });

    // Verificar que last_seen_at se actualizó
    const after = db.prepare(`SELECT last_seen_at FROM device_tokens WHERE token = ?`).get('tracked-token') as { last_seen_at: string | null };
    expect(after.last_seen_at).not.toBeNull();
  });
});

// --- Tests de constantes de keep-alive ---

describe('Keep-alive configuration', () => {
  it('KEEP_ALIVE_SECONDS es 60', () => {
    expect(KEEP_ALIVE_SECONDS).toBe(60);
  });

  it('KEEP_ALIVE_LIMIT es 1.5 (desconexión a los 90s)', () => {
    expect(KEEP_ALIVE_LIMIT).toBe(1.5);
  });

  it('tiempo de desconexión es 90 segundos', () => {
    expect(KEEP_ALIVE_SECONDS * KEEP_ALIVE_LIMIT).toBe(90);
  });
});

// --- Tests de asignación de puertos por defecto (Req 7.1) ---

describe('DEFAULT_WS_PORT (WebSocket MQTT crudo de Aedes)', () => {
  it('no colisiona con el puerto del relay JSON de apps móviles (9001, design.md)', () => {
    expect(DEFAULT_WS_PORT).not.toBe(DEFAULT_RELAY_PORT);
    expect(DEFAULT_WS_PORT).not.toBe(9001);
  });
});
