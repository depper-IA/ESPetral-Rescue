/**
 * CALI Rescue System — Tests para el módulo de base de datos
 *
 * Verifica la creación del esquema, índices y la purga automática de datos.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { initializeDatabase, purgeExpiredData, stopPurgeDaemon } from './database.js';
import type Database from 'better-sqlite3-multiple-ciphers';

describe('database', () => {
  let db: Database.Database;

  afterEach(() => {
    stopPurgeDaemon();
    if (db) db.close();
  });

  describe('initializeDatabase', () => {
    it('crea todas las tablas del esquema', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('zones');
      expect(tableNames).toContain('csi_readings');
      expect(tableNames).toContain('acoustic_reports');
      expect(tableNames).toContain('location_entries');
      expect(tableNames).toContain('device_tokens');
      expect(tableNames).toContain('probability_scores');
    });

    it('crea los índices para consultas de expiración', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_csi_zone_time');
      expect(indexNames).toContain('idx_csi_received_at');
      expect(indexNames).toContain('idx_locations_device');
      expect(indexNames).toContain('idx_locations_received_at');
      expect(indexNames).toContain('idx_acoustic_zone');
      expect(indexNames).toContain('idx_acoustic_received_at');
    });

    it('configura WAL mode y foreign keys', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      const journalMode = db.pragma('journal_mode', { simple: true });
      const foreignKeys = db.pragma('foreign_keys', { simple: true });

      // In-memory SQLite cannot use WAL — it reports 'memory' instead.
      // The production code sets WAL mode, but for :memory: databases
      // the engine silently ignores it. This is expected SQLite behavior.
      expect(['wal', 'memory']).toContain(journalMode);
      expect(foreignKeys).toBe(1);
    });

    it('es idempotente al ejecutar múltiples veces', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });
      // Simular re-creación del esquema (IF NOT EXISTS)
      expect(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS zones (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          center_lat REAL NOT NULL,
          center_lon REAL NOT NULL,
          radius_m REAL NOT NULL DEFAULT 50,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
      }).not.toThrow();
    });
  });

  describe('purgeExpiredData', () => {
    it('elimina registros con más de 72 horas de antigüedad', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      // Insertar zona de prueba
      db.prepare(`INSERT INTO zones (id, name, center_lat, center_lon) VALUES (?, ?, ?, ?)`)
        .run('zone-1', 'Test Zone', 3.45, -76.53);

      // Insertar lectura CSI antigua (73 horas atrás)
      const oldDate = new Date(Date.now() - 73 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      db.prepare(
        `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at, received_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('zone-1', 'node-1', 0.5, oldDate, oldDate);

      // Insertar lectura CSI reciente (1 hora atrás)
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      db.prepare(
        `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at, received_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('zone-1', 'node-2', 0.7, recentDate, recentDate);

      // Insertar reporte acústico antiguo
      db.prepare(
        `INSERT INTO acoustic_reports (id, zone_id, device_token, peak_count, mean_interval_ms, confidence, reported_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('report-1', 'zone-1', 'token-1', 4, 500.0, 0.8, oldDate, oldDate);

      // Insertar entrada de ubicación antigua
      db.prepare(
        `INSERT INTO location_entries (id, device_token, lat, lon, accuracy_m, captured_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('loc-1', 'token-1', 3.45, -76.53, 10.0, oldDate, oldDate);

      const result = purgeExpiredData(db);

      expect(result.csiDeleted).toBe(1);
      expect(result.acousticDeleted).toBe(1);
      expect(result.locationDeleted).toBe(1);

      // Verificar que la lectura reciente persiste
      const remaining = db.prepare(`SELECT COUNT(*) as count FROM csi_readings`).get() as { count: number };
      expect(remaining.count).toBe(1);
    });

    it('no elimina registros dentro de las 72 horas', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      db.prepare(`INSERT INTO zones (id, name, center_lat, center_lon) VALUES (?, ?, ?, ?)`)
        .run('zone-1', 'Test Zone', 3.45, -76.53);

      // Insertar lectura de hace 71 horas (dentro del TTL)
      const withinTtl = new Date(Date.now() - 71 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      db.prepare(
        `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at, received_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('zone-1', 'node-1', 0.3, withinTtl, withinTtl);

      const result = purgeExpiredData(db);

      expect(result.csiDeleted).toBe(0);
      expect(result.acousticDeleted).toBe(0);
      expect(result.locationDeleted).toBe(0);
    });
  });

  describe('constraints', () => {
    it('rechaza motion_probability fuera de rango [0, 1]', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      db.prepare(`INSERT INTO zones (id, name, center_lat, center_lon) VALUES (?, ?, ?, ?)`)
        .run('zone-1', 'Test Zone', 3.45, -76.53);

      expect(() => {
        db.prepare(
          `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at)
           VALUES (?, ?, ?, ?)`
        ).run('zone-1', 'node-1', 1.5, '2025-01-01 00:00:00');
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at)
           VALUES (?, ?, ?, ?)`
        ).run('zone-1', 'node-1', -0.1, '2025-01-01 00:00:00');
      }).toThrow();
    });

    it('rechaza device_type inválido', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      expect(() => {
        db.prepare(
          `INSERT INTO device_tokens (token, device_type) VALUES (?, ?)`
        ).run('tok-1', 'invalid');
      }).toThrow();
    });

    it('aplica unicidad node_id + captured_at en csi_readings', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      db.prepare(`INSERT INTO zones (id, name, center_lat, center_lon) VALUES (?, ?, ?, ?)`)
        .run('zone-1', 'Test Zone', 3.45, -76.53);

      db.prepare(
        `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at)
         VALUES (?, ?, ?, ?)`
      ).run('zone-1', 'node-1', 0.5, '2025-01-01 00:00:00');

      expect(() => {
        db.prepare(
          `INSERT INTO csi_readings (zone_id, node_id, motion_probability, captured_at)
           VALUES (?, ?, ?, ?)`
        ).run('zone-1', 'node-1', 0.6, '2025-01-01 00:00:00');
      }).toThrow();
    });

    it('rechaza probability_scores.score fuera de rango [0, 100]', () => {
      db = initializeDatabase({ inMemory: true, enablePurge: false });

      db.prepare(`INSERT INTO zones (id, name, center_lat, center_lon) VALUES (?, ?, ?, ?)`)
        .run('zone-1', 'Test Zone', 3.45, -76.53);

      expect(() => {
        db.prepare(
          `INSERT INTO probability_scores (zone_id, score) VALUES (?, ?)`
        ).run('zone-1', 101);
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO probability_scores (zone_id, score) VALUES (?, ?)`
        ).run('zone-1', -1);
      }).toThrow();
    });
  });
});
