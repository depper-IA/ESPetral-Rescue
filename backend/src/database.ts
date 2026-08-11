/**
 * CALI Rescue System — Módulo de base de datos SQLite
 *
 * Crea el esquema completo, índices para consultas de expiración,
 * y un daemon de purga automática con TTL de 72 horas (ejecuta cada 15 minutos).
 *
 * Requisitos: 6.3 (almacenamiento de telemetría), 11.1 (scoring por zona)
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ruta por defecto para la base de datos (relativa al directorio del proyecto)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'cali_rescue.db');

/** Tiempo de vida de los datos en milisegundos (72 horas) */
const TTL_MS = 72 * 60 * 60 * 1000;

/** Intervalo de ejecución del daemon de purga en milisegundos (15 minutos) */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Sentencias SQL para crear el esquema completo del sistema.
 * Incluye todas las tablas necesarias para zonas, lecturas CSI,
 * reportes acústicos, entradas de ubicación, tokens de dispositivo
 * y puntajes de probabilidad.
 */
const SCHEMA_SQL = `
-- Definición de zonas de búsqueda
CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    radius_m REAL NOT NULL DEFAULT 50,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lecturas CSI recibidas desde nodos ESP32
CREATE TABLE IF NOT EXISTS csi_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL REFERENCES zones(id),
    node_id TEXT NOT NULL,
    motion_probability REAL NOT NULL CHECK(motion_probability >= 0.0 AND motion_probability <= 1.0),
    captured_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(node_id, captured_at)
);

-- Reportes de detección acústica desde apps móviles
CREATE TABLE IF NOT EXISTS acoustic_reports (
    id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL REFERENCES zones(id),
    device_token TEXT NOT NULL,
    peak_count INTEGER NOT NULL,
    mean_interval_ms REAL NOT NULL,
    confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
    lat REAL,
    lon REAL,
    reported_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entradas de ubicación sincronizadas desde apps móviles
CREATE TABLE IF NOT EXISTS location_entries (
    id TEXT PRIMARY KEY,
    device_token TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy_m REAL NOT NULL,
    note TEXT,
    captured_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tokens de autenticación de dispositivos
CREATE TABLE IF NOT EXISTS device_tokens (
    token TEXT PRIMARY KEY,
    device_type TEXT NOT NULL CHECK(device_type IN ('esp32', 'mobile')),
    label TEXT,
    zone_id TEXT REFERENCES zones(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
);

-- Puntajes de probabilidad compuestos (último por zona)
CREATE TABLE IF NOT EXISTS probability_scores (
    zone_id TEXT PRIMARY KEY REFERENCES zones(id),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    csi_contribution REAL,
    acoustic_contribution REAL,
    gps_contribution REAL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índices para rendimiento en consultas temporales y de expiración
CREATE INDEX IF NOT EXISTS idx_csi_zone_time ON csi_readings(zone_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_csi_received_at ON csi_readings(received_at);
CREATE INDEX IF NOT EXISTS idx_locations_device ON location_entries(device_token, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_locations_received_at ON location_entries(received_at);
CREATE INDEX IF NOT EXISTS idx_acoustic_zone ON acoustic_reports(zone_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_acoustic_received_at ON acoustic_reports(received_at);
`;

/** Referencia al intervalo del daemon de purga (para poder detenerlo) */
let purgeIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Ejecuta la purga de registros con más de 72 horas de antigüedad.
 * Elimina filas de csi_readings, acoustic_reports y location_entries
 * donde received_at es anterior al umbral de expiración.
 */
export function purgeExpiredData(db: Database.Database): {
  csiDeleted: number;
  acousticDeleted: number;
  locationDeleted: number;
} {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString().replace('T', ' ').slice(0, 19);

  const csiResult = db.prepare(
    `DELETE FROM csi_readings WHERE received_at < ?`
  ).run(cutoff);

  const acousticResult = db.prepare(
    `DELETE FROM acoustic_reports WHERE received_at < ?`
  ).run(cutoff);

  const locationResult = db.prepare(
    `DELETE FROM location_entries WHERE received_at < ?`
  ).run(cutoff);

  return {
    csiDeleted: csiResult.changes,
    acousticDeleted: acousticResult.changes,
    locationDeleted: locationResult.changes,
  };
}

/**
 * Inicia el daemon de purga automática que ejecuta cada 15 minutos.
 * Si ya hay un daemon corriendo, no crea uno nuevo.
 */
export function startPurgeDaemon(db: Database.Database): void {
  if (purgeIntervalId !== null) return;

  purgeIntervalId = setInterval(() => {
    try {
      const result = purgeExpiredData(db);
      const total = result.csiDeleted + result.acousticDeleted + result.locationDeleted;
      if (total > 0) {
        console.log(
          `[purge] Registros eliminados: CSI=${result.csiDeleted}, ` +
          `acústicos=${result.acousticDeleted}, ubicación=${result.locationDeleted}`
        );
      }
    } catch (err) {
      console.error('[purge] Error durante purga automática:', err);
    }
  }, PURGE_INTERVAL_MS);

  // Permitir que el proceso termine aunque el intervalo esté activo
  if (purgeIntervalId.unref) {
    purgeIntervalId.unref();
  }
}

/**
 * Detiene el daemon de purga automática.
 * Útil para pruebas y apagado limpio del servidor.
 */
export function stopPurgeDaemon(): void {
  if (purgeIntervalId !== null) {
    clearInterval(purgeIntervalId);
    purgeIntervalId = null;
  }
}

/** Opciones para inicializar la base de datos */
export interface DatabaseOptions {
  /** Ruta al archivo .db (por defecto: backend/data/cali_rescue.db) */
  dbPath?: string;
  /** Si true, inicia el daemon de purga automática (por defecto: true) */
  enablePurge?: boolean;
  /** Si true, usa base de datos en memoria (útil para pruebas) */
  inMemory?: boolean;
  /**
   * Clave de cifrado para SQLCipher.
   * better-sqlite3-multiple-ciphers incluye soporte nativo SQLCipher4.
   * Si se proporciona, aplica cifrado at-rest a toda la base de datos.
   */
  encryptionKey?: string;
}

/**
 * Inicializa la base de datos SQLite: crea el directorio si no existe,
 * aplica el esquema completo y opcionalmente inicia el daemon de purga.
 *
 * Cifrado SQLCipher: si se proporciona `encryptionKey`, se activa SQLCipher4
 * mediante better-sqlite3-multiple-ciphers para cifrado at-rest completo.
 * Sin la clave, la base de datos opera sin cifrado (adecuado para desarrollo).
 *
 * @returns La instancia de la base de datos lista para usar.
 */
export function initializeDatabase(options: DatabaseOptions = {}): Database.Database {
  const {
    dbPath = DEFAULT_DB_PATH,
    enablePurge = true,
    inMemory = false,
    encryptionKey,
  } = options;

  // Crear directorio para la base de datos si no existe
  if (!inMemory) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(inMemory ? ':memory:' : dbPath);

  // Aplicar cifrado SQLCipher si se proporciona clave
  // better-sqlite3-multiple-ciphers incluye soporte nativo para SQLCipher
  if (encryptionKey) {
    db.pragma('cipher = sqlcipher');
    db.pragma('legacy = 4');
    db.pragma(`key = '${encryptionKey.replace(/'/g, "''")}'`);
  }

  // Configuración de rendimiento y seguridad
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Crear esquema completo
  db.exec(SCHEMA_SQL);

  // Iniciar daemon de purga automática
  if (enablePurge) {
    startPurgeDaemon(db);
  }

  return db;
}

export default initializeDatabase;
