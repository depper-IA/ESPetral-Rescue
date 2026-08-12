// Monitor: ve cuando el nodo ESP32 aparece en el broker.
// Imprime timestamp + mensaje cada vez que entra algo al broker.
// Timeout: 60 segundos (suficiente para que el nodo se conecte + CSI llene ventana).
const mqtt = require('mqtt');
const WS = require('ws');

const start = Date.now();
let csiCount = 0;
let rawCount = 0;
let lastMsg = 0;

const c = mqtt.connect('mqtt://127.0.0.1:1883', {
  username: 'esp32-s3-001',
  password: 'internal-relay-token',
  clientId: 'monitor-' + Date.now(),
});

c.on('connect', () => {
  console.log(`[${formatElapsed()}] [MON] Conectado al broker como esp32-s3-001`);
  c.subscribe('cali/zone/+/csi');
  c.subscribe('cali/zone/+/csi_raw');
  c.subscribe('cali/zone/+/status');
  console.log(`[${formatElapsed()}] [MON] Esperando mensajes del nodo...`);
});

c.on('message', (topic, msg) => {
  const t = formatElapsed();
  lastMsg = Date.now();
  let summary = '';
  try {
    const m = JSON.parse(msg.toString());
    if (topic.endsWith('/csi')) {
      csiCount++;
      summary = `motion_probability=${m.motion_probability}`;
    } else if (topic.endsWith('/csi_raw')) {
      rawCount++;
      const n = Array.isArray(m.subcarrier_amplitudes) ? m.subcarrier_amplitudes.length : '?';
      summary = `${n} amplitudes`;
    } else if (topic.endsWith('/status')) {
      summary = `status=${m.status}`;
    }
  } catch (e) { summary = msg.toString().slice(0, 80); }
  console.log(`[${t}] [${topic}] ${summary}`);
});

const ws = new WS('ws://127.0.0.1:3000/ws/dashboard');
ws.on('open', () => console.log(`[${formatElapsed()}] [DASH] Conectado al dashboard WS`));
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'csi_update' && m.node_id === 'esp32-s3-001') {
    lastMsg = Date.now();
    console.log(`[${formatElapsed()}] [DASH-BROADCAST] csi_update prob=${m.motion_probability}`);
  }
  if (m.type === 'csi_raw_update' && m.node_id === 'esp32-s3-001') {
    lastMsg = Date.now();
    const n = Array.isArray(m.subcarrier_amplitudes) ? m.subcarrier_amplitudes.length : '?';
    console.log(`[${formatElapsed()}] [DASH-BROADCAST] csi_raw_update ${n} amplitudes`);
  }
});

function formatElapsed() {
  const s = Math.floor((Date.now() - start) / 1000);
  return `${s}s`;
}

setInterval(() => {
  const sinceLast = Math.floor((Date.now() - lastMsg) / 1000);
  if (lastMsg > 0 && sinceLast > 5) {
    console.log(`[${formatElapsed()}] [WAIT] ${sinceLast}s sin mensajes del nodo (csi=${csiCount}, raw=${rawCount})`);
    lastMsg = Date.now();
  }
}, 5000);

setTimeout(() => {
  console.log(`\n[${formatElapsed()}] === RESUMEN ===`);
  console.log(`Total mensajes csi del nodo: ${csiCount}`);
  console.log(`Total mensajes csi_raw del nodo: ${rawCount}`);
  console.log(`
${csiCount > 0 || rawCount > 0 ? '[OK] NODO CONECTADO - END-TO-END FUNCIONA' : '[FAIL] Nodo no aparece. Revisa: (1) ESP32 conectado a Travis? (2) mqtt_host=192.168.1.8 correcto? (3) Token en device_tokens del backend?'}`);
  process.exit(csiCount > 0 || rawCount > 0 ? 0 : 1);
}, 60000);