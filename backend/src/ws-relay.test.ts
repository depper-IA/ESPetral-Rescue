/**
 * CALI Rescue System — Tests para el WebSocket Relay de apps móviles
 *
 * Verifica validación de batches, deduplicación de entradas,
 * almacenamiento en SQLite y protocolo de mensajes.
 *
 * Requisitos: 8.1, 8.2, 13.1, 13.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateLocationEntry,
  validateSyncBatch,
  storeLocationEntries,
  MAX_BATCH_SIZE,
} from './ws-relay.js';
import { initializeDatabase, stopPurgeDaemon } from './database.js';
import type Database from 'better-sqlite3';
import type { LocationEntry } from './types.js';

// --- Helpers ---

function makeEntry(overrides: Partial<LocationEntry> = {}): LocationEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    lat: 3.45,
    lon: -76.53,
    accuracy: 10,
    note: 'Punto de búsqueda',
    synced: false,
    ...overrides,
  };
}

// --- Tests ---

describe('ws-relay', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase({ inMemory: true, enablePurge: false });
  });

  afterEach(() => {
    stopPurgeDaemon();
    if (db) db.close();
  });

  describe('validateLocationEntry', () => {
    it('acepta una entrada válida', () => {
      const entry = makeEntry();
      expect(validateLocationEntry(entry)).toBeNull();
    });

    it('rechaza entrada sin id', () => {
      const entry = makeEntry({ id: '' });
      expect(validateLocationEntry(entry)).toContain('id');
    });

    it('rechaza lat fuera de rango', () => {
      expect(validateLocationEntry(makeEntry({ lat: 91 }))).toContain('lat');
      expect(validateLocationEntry(makeEntry({ lat: -91 }))).toContain('lat');
    });

    it('rechaza lon fuera de rango', () => {
      expect(validateLocationEntry(makeEntry({ lon: 181 }))).toContain('lon');
      expect(validateLocationEntry(makeEntry({ lon: -181 }))).toContain('lon');
    });

    it('rechaza accuracy negativo', () => {
      expect(validateLocationEntry(makeEntry({ accuracy: -1 }))).toContain('accuracy');
    });

    it('rechaza entrada null o no-objeto', () => {
      expect(validateLocationEntry(null)).toContain('objeto');
      expect(validateLocationEntry('string')).toContain('objeto');
      expect(validateLocationEntry(42)).toContain('objeto');
    });
  });

  describe('validateSyncBatch', () => {
    it('acepta un batch válido con entradas', () => {
      const batch = {
        device_token: 'mobile-token-123',
        entries: [makeEntry(), makeEntry()],
      };

      const result = validateSyncBatch(batch);
      expect(result.valid).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect(result.deviceToken).toBe('mobile-token-123');
      expect(result.errors).toHaveLength(0);
    });

    it('rechaza batch sin device_token', () => {
      const batch = { entries: [makeEntry()] };
      const result = validateSyncBatch(batch);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].reason).toContain('device_token');
    });

    it('rechaza batch con entries no-array', () => {
      const batch = { device_token: 'tok', entries: 'not-array' };
      const result = validateSyncBatch(batch);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].reason).toContain('entries');
    });

    it('rechaza batch que excede MAX_BATCH_SIZE', () => {
      const entries = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => makeEntry());
      const batch = { device_token: 'tok', entries };
      const result = validateSyncBatch(batch);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].reason).toContain(`${MAX_BATCH_SIZE}`);
    });

    it('separa entradas válidas de inválidas', () => {
      const batch = {
        device_token: 'tok',
        entries: [
          makeEntry({ id: 'good-1' }),
          { id: '', lat: 'bad' }, // inválida
          makeEntry({ id: 'good-2' }),
        ],
      };

      const result = validateSyncBatch(batch);
      expect(result.entries).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain('id');
    });

    it('rechaza payload null', () => {
      const result = validateSyncBatch(null);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('storeLocationEntries', () => {
    it('almacena entradas nuevas en SQLite', () => {
      const entries = [makeEntry({ id: 'loc-1' }), makeEntry({ id: 'loc-2' })];

      const result = storeLocationEntries(db, entries, 'device-tok-1');

      expect(result.storedIds).toEqual(['loc-1', 'loc-2']);
      expect(result.duplicateIds).toHaveLength(0);

      // Verificar en la base de datos
      const count = db.prepare('SELECT COUNT(*) as c FROM location_entries').get() as { c: number };
      expect(count.c).toBe(2);
    });

    it('deduplica entradas con ID repetido (first received wins)', () => {
      // Primera inserción
      const entry1 = makeEntry({ id: 'dup-1', lat: 3.45, note: 'Primera' });
      storeLocationEntries(db, [entry1], 'device-tok-1');

      // Segunda inserción con mismo ID pero datos diferentes
      const entry2 = makeEntry({ id: 'dup-1', lat: 4.00, note: 'Segunda' });
      const result = storeLocationEntries(db, [entry2], 'device-tok-1');

      expect(result.storedIds).toEqual(['dup-1']);
      expect(result.duplicateIds).toEqual(['dup-1']);

      // Verificar que se mantuvo la primera
      const stored = db.prepare('SELECT note FROM location_entries WHERE id = ?').get('dup-1') as { note: string };
      expect(stored.note).toBe('Primera');
    });

    it('maneja batch con mezcla de nuevos y duplicados', () => {
      // Insertar uno existente
      storeLocationEntries(db, [makeEntry({ id: 'existing' })], 'tok');

      // Enviar batch con existente + nuevos
      const entries = [
        makeEntry({ id: 'existing' }),
        makeEntry({ id: 'new-1' }),
        makeEntry({ id: 'new-2' }),
      ];

      const result = storeLocationEntries(db, entries, 'tok');

      expect(result.storedIds).toEqual(['existing', 'new-1', 'new-2']);
      expect(result.duplicateIds).toEqual(['existing']);

      const count = db.prepare('SELECT COUNT(*) as c FROM location_entries').get() as { c: number };
      expect(count.c).toBe(3);
    });

    it('almacena device_token correctamente', () => {
      const entry = makeEntry({ id: 'loc-device' });
      storeLocationEntries(db, [entry], 'my-mobile-device');

      const stored = db.prepare('SELECT device_token FROM location_entries WHERE id = ?')
        .get('loc-device') as { device_token: string };
      expect(stored.device_token).toBe('my-mobile-device');
    });

    it('maneja batch vacío sin errores', () => {
      const result = storeLocationEntries(db, [], 'tok');
      expect(result.storedIds).toHaveLength(0);
      expect(result.duplicateIds).toHaveLength(0);
    });
  });
});
