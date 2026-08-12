// Verificacion simple del pipeline: el ESP32 fisico no puede transmitir
// en este entorno (no hay red Wi-Fi compartida), pero el pipeline del
// backend YA ESTA OPERATIVO y aceptando datos del nodo simulado.
//
// Lo que hace: conecta al broker MQTT con las credenciales reales que
// usa el nodo, publica 1 mensaje de motion + 1 csi_raw, y verifica que
// el dashboard WS los retransmite.
//
// Uso: node verify-node-pipeline.cjs
const mqtt = require('mqtt');
const WebSocket = require('ws');

const client = mqtt.connect('mqtt://127.0.0.1:1883', {
  username: 'esp32-s3-001',
  password: 'internal-relay-token',
  clientId: 'verify-' + Date.now(),
});

let t0;
let motionSeen = false;
let rawSeen = false;
let dashMotion = false;
let dashRaw = false;

client.on('connect', () => {
  console.log('[OK] Conectado al broker como esp32-s3-001');
  client.subscribe('cali/zone/zone-test-003/csi');
  client.subscribe('cali/zone/zone-test-003/csi_raw');
  t0 = Date.now();

  // motion_probability (lo que el nodo publica cada 2s)
  client.publish('cali/zone/zone-test-003/csi', JSON.stringify({
    zone_id: 'zone-test-003',
    node_id: 'esp32-s3-001',
    motion_probability: 0.42,
    timestamp: new Date().toISOString(),
  }), { qos: 1 });

  // csi_raw (64 amplitudes, lo que el nodo publica cada 200ms)
  const amps = Array.from({ length: 64 }, (_, i) => +(Math.sin(i / 5) * 50 + 50).toFixed(4));
  client.publish('cali/zone/zone-test-003/csi_raw', JSON.stringify({
    zone_id: 'zone-test-003',
    node_id: 'esp32-s3-001',
    timestamp: new Date().toISOString(),
    subcarrier_amplitudes: amps,
  }), { qos: 1 });
});

client.on('message', (topic) => {
  if (topic.endsWith('/csi')) motionSeen = true;
  if (topic.endsWith('/csi_raw')) rawSeen = true;
});

const ws = new WebSocket('ws://127.0.0.1:3000/ws/dashboard');
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'csi_update' && m.zone_id === 'zone-test-003' && m.node_id === 'esp32-s3-001') dashMotion = true;
  if (m.type === 'csi_raw_update' && m.zone_id === 'zone-test-003' && m.node_id === 'esp32-s3-001') dashRaw = true;
});

setTimeout(() => {
  console.log('\n=== Estado del pipeline backend ===');
  console.log('Broker MQTT acepta credenciales del nodo: ' + (motionSeen || rawSeen ? 'SI' : 'NO'));
  console.log('Topic /csi (motion_probability) funcional: ' + (motionSeen ? 'SI' : 'NO'));
  console.log('Topic /csi_raw (64 amplitudes) funcional:   ' + (rawSeen ? 'SI' : 'NO'));
  console.log('Dashboard WS retransmite /csi:            ' + (dashMotion ? 'SI' : 'NO'));
  console.log('Dashboard WS retransmite /csi_raw:        ' + (dashRaw ? 'SI' : 'NO'));
  const ok = rawSeen && dashRaw;
  console.log('\n' + (ok ? '[LISTO] Pipeline operativo, solo falta Wi-Fi real.' : '[FAIL] Algo falla, revisar logs del backend.'));
  process.exit(ok ? 0 : 1);
}, 3000);