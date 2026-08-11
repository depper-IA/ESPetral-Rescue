/**
 * Tests unitarios para el motor de ubicación.
 * Verifica persistencia, orden cronológico inverso, append sin sobrescribir,
 * manejo de errores, y eventos.
 *
 * Requisitos: 5.1, 5.2, 5.3, 5.5, 2.1
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LocationEngine,
  serializeEntries,
  deserializeEntries,
  sortEntriesReverseChronological,
  generateId,
  type LocationEntry,
  type LocationEngineEvent,
} from './location-engine';
import { EncryptedStorage } from './encrypted-storage';

// --- Funciones puras ---

describe('serializeEntries / deserializeEntries', () => {
  const sampleEntry: LocationEntry = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2024-01-15T10:30:00.000Z',
    lat: 3.4516,
    lon: -76.5320,
    accuracy: 12.5,
    note: 'Posible señal en sector norte',
    synced: false,
  };

  it('debe serializar y deserializar correctamente (round-trip)', () => {
    const serialized = serializeEntries([sampleEntry]);
    const deserialized = deserializeEntries(serialized);
    expect(deserialized).toEqual([sampleEntry]);
  });

  it('debe manejar lista vacía', () => {
    const serialized = serializeEntries([]);
    const deserialized = deserializeEntries(serialized);
    expect(deserialized).toEqual([]);
  });

  it('debe retornar null para JSON inválido', () => {
    expect(deserializeEntries('no-json')).toBeNull();
  });

  it('debe retornar null si falta version', () => {
    expect(deserializeEntries('{"entries":[]}')).toBeNull();
  });

  it('debe retornar null si version no es 1', () => {
    expect(deserializeEntries('{"version":2,"entries":[]}')).toBeNull();
  });

  it('debe retornar null si entries no es array', () => {
    expect(deserializeEntries('{"version":1,"entries":"no"}')).toBeNull();
  });

  it('debe retornar null si una entrada tiene campos inválidos', () => {
    const invalid = JSON.stringify({
      version: 1,
      entries: [{ id: 123, timestamp: '2024-01-01', lat: 'no', lon: 0, accuracy: 0, note: '', synced: false }],
    });
    expect(deserializeEntries(invalid)).toBeNull();
  });

  it('debe retornar null si falta el campo synced', () => {
    const invalid = JSON.stringify({
      version: 1,
      entries: [{ id: 'x', timestamp: '2024-01-01', lat: 0, lon: 0, accuracy: 0, note: '' }],
    });
    expect(deserializeEntries(invalid)).toBeNull();
  });
});

describe('sortEntriesReverseChronological', () => {
  it('debe ordenar entradas de más reciente a más antigua', () => {
    const entries: LocationEntry[] = [
      { id: '1', timestamp: '2024-01-01T10:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
      { id: '2', timestamp: '2024-01-01T12:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
      { id: '3', timestamp: '2024-01-01T08:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
    ];
    const sorted = sortEntriesReverseChronological(entries);
    expect(sorted[0].id).toBe('2');
    expect(sorted[1].id).toBe('1');
    expect(sorted[2].id).toBe('3');
  });

  it('debe retornar copia nueva sin mutar el original', () => {
    const entries: LocationEntry[] = [
      { id: '1', timestamp: '2024-01-01T12:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
      { id: '2', timestamp: '2024-01-01T10:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
    ];
    const sorted = sortEntriesReverseChronological(entries);
    expect(sorted).not.toBe(entries);
    expect(entries[0].id).toBe('1'); // Original no mutado
  });

  it('debe manejar lista vacía', () => {
    expect(sortEntriesReverseChronological([])).toEqual([]);
  });
});

describe('generateId', () => {
  it('debe generar un string con formato UUID', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('debe generar IDs únicos', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// --- LocationEngine con EncryptedStorage mockeado ---

describe('LocationEngine', () => {
  let engine: LocationEngine;
  let storageMock: EncryptedStorage;
  let storedData: string | null;

  beforeEach(() => {
    storedData = null;

    // Mock del EncryptedStorage
    storageMock = {
      localStorageAvailable: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockImplementation(async (data: string) => {
        storedData = data;
        return { success: true };
      }),
      read: vi.fn().mockImplementation(async () => {
        if (storedData) {
          return { success: true, data: storedData, recovered: false };
        }
        return { success: true, data: null, recovered: false };
      }),
      clear: vi.fn(() => { storedData = null; }),
    } as unknown as EncryptedStorage;

    engine = new LocationEngine(storageMock);
  });

  it('debe inicializarse correctamente', async () => {
    await engine.initialize();
    expect(engine.status.initialized).toBe(true);
    expect(engine.status.localStorageAvailable).toBe(true);
  });

  it('debe agregar entradas con todos los campos correctos', async () => {
    await engine.initialize();
    const entry = await engine.addEntry(3.45, -76.53, 10, 'Sector norte');

    expect(entry.lat).toBe(3.45);
    expect(entry.lon).toBe(-76.53);
    expect(entry.accuracy).toBe(10);
    expect(entry.note).toBe('Sector norte');
    expect(entry.synced).toBe(false);
    expect(entry.id).toMatch(/^[0-9a-f-]+$/);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('debe persistir al agregar una entrada (append)', async () => {
    await engine.initialize();
    await engine.addEntry(3.45, -76.53, 10, 'Primera');

    expect(storageMock.write).toHaveBeenCalledTimes(1);

    // Verificar que los datos persisten con append
    await engine.addEntry(3.46, -76.54, 15, 'Segunda');
    expect(storageMock.write).toHaveBeenCalledTimes(2);

    // Verificar que la segunda escritura contiene ambas entradas
    const lastCall = (storageMock.write as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const parsed = JSON.parse(lastCall);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].note).toBe('Primera');
    expect(parsed.entries[1].note).toBe('Segunda');
  });

  it('debe retornar entradas en orden cronológico inverso', async () => {
    await engine.initialize();

    // Agregar con timestamps controlados usando fake timers
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T10:00:00Z'));
    const entry1 = await engine.addEntry(1, 1, 5, 'Primera');

    vi.setSystemTime(new Date('2024-06-01T10:01:00Z'));
    const entry2 = await engine.addEntry(2, 2, 5, 'Segunda');
    vi.useRealTimers();

    const entries = engine.getEntries();
    // La segunda (más reciente) debe aparecer primero
    expect(entries[0].id).toBe(entry2.id);
    expect(entries[1].id).toBe(entry1.id);
  });

  it('debe emitir evento entry_added al agregar', async () => {
    await engine.initialize();
    const events: LocationEngineEvent[] = [];
    engine.on(event => events.push(event));

    await engine.addEntry(3.45, -76.53, 10, 'Test');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('entry_added');
  });

  it('debe emitir persist_error cuando write falla', async () => {
    (storageMock.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'quota_exceeded',
      message: 'Cuota excedida',
    });

    await engine.initialize();
    const events: LocationEngineEvent[] = [];
    engine.on(event => events.push(event));

    await engine.addEntry(3.45, -76.53, 10, 'Test');

    const persistErrors = events.filter(e => e.type === 'persist_error');
    expect(persistErrors).toHaveLength(1);
    expect(engine.status.lastPersistError).toBe('Cuota excedida');
  });

  it('debe emitir storage_unavailable cuando localStorage no está disponible', async () => {
    (storageMock as unknown as { localStorageAvailable: boolean }).localStorageAvailable = false;
    engine = new LocationEngine(storageMock);

    const events: LocationEngineEvent[] = [];
    engine.on(event => events.push(event));

    await engine.initialize();

    const storageEvents = events.filter(e => e.type === 'storage_unavailable');
    expect(storageEvents).toHaveLength(1);
  });

  it('debe emitir data_recovered cuando read retorna recovered=true', async () => {
    (storageMock.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: null,
      recovered: true,
      error: 'Datos corruptos',
    });

    const events: LocationEngineEvent[] = [];
    engine.on(event => events.push(event));

    await engine.initialize();

    const recoveryEvents = events.filter(e => e.type === 'data_recovered');
    expect(recoveryEvents).toHaveLength(1);
  });

  it('debe cargar entradas existentes al inicializar', async () => {
    const existingEntries: LocationEntry[] = [
      { id: 'existing-1', timestamp: '2024-01-01T10:00:00Z', lat: 3.45, lon: -76.53, accuracy: 10, note: 'Previa', synced: true },
    ];
    storedData = serializeEntries(existingEntries);

    await engine.initialize();

    expect(engine.status.entryCount).toBe(1);
    expect(engine.getEntries()[0].id).toBe('existing-1');
  });

  it('debe retornar entradas no sincronizadas en orden cronológico', async () => {
    const entries: LocationEntry[] = [
      { id: '1', timestamp: '2024-01-01T12:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: true },
      { id: '2', timestamp: '2024-01-01T10:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
      { id: '3', timestamp: '2024-01-01T11:00:00Z', lat: 0, lon: 0, accuracy: 0, note: '', synced: false },
    ];
    storedData = serializeEntries(entries);

    await engine.initialize();

    const unsynced = engine.getUnsyncedEntries();
    expect(unsynced).toHaveLength(2);
    expect(unsynced[0].id).toBe('2'); // Más antigua primero
    expect(unsynced[1].id).toBe('3');
  });

  it('debe marcar entradas como sincronizadas', async () => {
    await engine.initialize();
    const entry = await engine.addEntry(3.45, -76.53, 10, 'Test');

    expect(entry.synced).toBe(false);
    await engine.markSynced([entry.id]);

    const entries = engine.getEntries();
    expect(entries[0].synced).toBe(true);
  });

  it('debe limpiar todas las entradas con clear()', async () => {
    await engine.initialize();
    await engine.addEntry(3.45, -76.53, 10, 'Test');

    engine.clear();

    expect(engine.status.entryCount).toBe(0);
    expect(storageMock.clear).toHaveBeenCalled();
  });

  it('debe permitir desuscribirse de eventos', async () => {
    await engine.initialize();
    const events: LocationEngineEvent[] = [];
    const unsub = engine.on(event => events.push(event));

    await engine.addEntry(3.45, -76.53, 10, 'Test 1');
    unsub();
    await engine.addEntry(3.46, -76.54, 10, 'Test 2');

    // Solo debe recibir el primer evento
    expect(events).toHaveLength(1);
  });

  it('debe retener entradas en memoria incluso cuando write falla', async () => {
    (storageMock.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'quota_exceeded',
      message: 'Cuota excedida',
    });

    await engine.initialize();
    await engine.addEntry(3.45, -76.53, 10, 'En memoria');

    // La entrada sigue en memoria a pesar del error de persistencia
    expect(engine.status.entryCount).toBe(1);
    expect(engine.getEntries()[0].note).toBe('En memoria');
  });
});
