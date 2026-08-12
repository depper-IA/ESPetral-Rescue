#!/usr/bin/env node
/**
 * ESPetral Rescue — Script de seed de zonas de prueba en SQLite.
 *
 * Inserta 3 zonas de ejemplo en Cali, Colombia dentro de
 * backend/data/cali_rescue.db. Es idempotente: si las zonas ya existen
 * (mismo id), no las duplica.
 *
 * Ejecucion:
 *   node scripts/seed-zones.mjs
 *   cd backend && pnpm seed:zones
 *
 * Convenciones del proyecto:
 * - Mensajes y errores en espanol
 * - Sin emojis
 * - Coordenadas aproximadas (no son exactas; solo sirven como datos de
 *   prueba para validar el motor de scoring)
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolucion de rutas: el script vive en <root>/scripts/ y la BD en
// <root>/backend/data/cali_rescue.db. La dependencia better-sqlite3
// esta instalada en <root>/backend/node_modules/ (alias de
// better-sqlite3-multiple-ciphers), asi que usamos createRequire
// anclado al package.json del backend para que el resolvedor CJS
// encuentre el modulo independientemente del cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'backend', 'data', 'cali_rescue.db');

const backendRequire = createRequire(
  path.join(PROJECT_ROOT, 'backend', 'package.json'),
);
const Database = backendRequire('better-sqlite3');

/** Esquema minimo requerido para que las zonas existan. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    radius_m REAL NOT NULL DEFAULT 50,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Zonas de prueba en Cali, Colombia. */
const ZONAS_PRUEBA = [
  {
    id: 'zone-test-001',
    name: 'Zona 1 - Edificio Norte',
    center_lat: 3.4600,
    center_lon: -76.5300,
    radius_m: 50,
  },
  {
    id: 'zone-test-002',
    name: 'Zona 2 - Plaza Central',
    center_lat: 3.4516,
    center_lon: -76.5320,
    radius_m: 80,
  },
  {
    id: 'zone-test-003',
    name: 'Zona 3 - Edificio Sur',
    center_lat: 3.4430,
    center_lon: -76.5330,
    radius_m: 50,
  },
];

function main() {
  // Garantizar que el directorio data/ existe antes de abrir la BD
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);

  try {
    // Activar WAL y claves foraneas igual que en el backend
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Crear el esquema (idempotente gracias a IF NOT EXISTS)
    db.exec(SCHEMA_SQL);

    const insertStmt = db.prepare(
      'INSERT OR IGNORE INTO zones (id, name, center_lat, center_lon, radius_m) VALUES (?, ?, ?, ?, ?)',
    );

    let creadas = 0;
    let existian = 0;

    const transaction = db.transaction((zonas) => {
      for (const zona of zonas) {
        const result = insertStmt.run(
          zona.id,
          zona.name,
          zona.center_lat,
          zona.center_lon,
          zona.radius_m,
        );
        if (result.changes > 0) {
          creadas += 1;
        } else {
          existian += 1;
        }
      }
    });

    transaction(ZONAS_PRUEBA);

    console.log(`Zonas creadas: ${creadas} (existed: ${existian})`);
    console.log(`Base de datos: ${DB_PATH}`);
  } finally {
    db.close();
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('Error durante el seed de zonas:');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
