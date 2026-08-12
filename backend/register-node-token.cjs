// Registra el token de un nodo ESP32 en device_tokens para que el broker
// MQTT del backend lo acepte. Uso: node register-node-token.cjs <token> <node_id> <zone_id>
const Database = require('better-sqlite3');
const path = require('path');

const token = process.argv[2];
const nodeId = process.argv[3];
const zoneId = process.argv[4];

if (!token || !nodeId || !zoneId) {
  console.log('Uso: node register-node-token.cjs <token> <node_id> <zone_id>');
  process.exit(1);
}

const dbPath = path.join(__dirname, 'data', 'cali_rescue.db');
const db = new Database(dbPath);

try {
  // Asegurar que la zona exista (la tabla zones referencia zone_id)
  const zoneExists = db.prepare('SELECT id FROM zones WHERE id = ?').get(zoneId);
  if (!zoneExists) {
    db.prepare(
      `INSERT INTO zones (id, name, center_lat, center_lon, radius_m)
       VALUES (?, ?, 0.0, 0.0, 50)`
    ).run(zoneId, zoneId);
    console.log('[OK] Zona creada:', zoneId);
  }

  // Insertar o reemplazar token
  const result = db.prepare(
    `INSERT OR REPLACE INTO device_tokens (token, device_type, label, zone_id, revoked)
     VALUES (?, 'esp32', ?, ?, 0)`
  ).run(token, `Nodo ${nodeId}`, zoneId);

  const tokens = db.prepare('SELECT token, device_type, label, revoked FROM device_tokens').all();
  console.log('[OK] Token registrado');
  console.log('Tokens actuales en device_tokens:');
  for (const t of tokens) {
    console.log(`  - ${t.token} (${t.device_type}, label=${t.label}, revoked=${t.revoked})`);
  }
} catch (e) {
  console.log('[ERR]', e.message);
  process.exit(1);
} finally {
  db.close();
}