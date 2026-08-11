/**
 * ESPetral Rescue — Tests para las funciones puras de sincronización de ubicaciones
 *
 * Feature: cali-rescue-system, Property 19: Location sync batching
 * Requisitos: 13.1, 13.2, 13.5
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  chunkEntriesForSync,
  filterRelevantAckIds,
  LOCATION_SYNC_BATCH_SIZE,
} from './location-sync';
import type { LocationEntry } from '../location/location-engine';

function makeEntry(id: string, timestampOffsetMs = 0): LocationEntry {
  return {
    id,
    timestamp: new Date(Date.UTC(2024, 0, 1) + timestampOffsetMs).toISOString(),
    lat: 3.45,
    lon: -76.53,
    accuracy: 10,
    note: '',
    synced: false,
  };
}

describe('LOCATION_SYNC_BATCH_SIZE', () => {
  it('es 50, según Req 13.1', () => {
    expect(LOCATION_SYNC_BATCH_SIZE).toBe(50);
  });
});

describe('chunkEntriesForSync', () => {
  it('retorna un array vacío para entradas vacías', () => {
    expect(chunkEntriesForSync([])).toEqual([]);
  });

  it('retorna un único batch cuando hay menos de 50 entradas', () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(`id-${i}`, i));
    const batches = chunkEntriesForSync(entries);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
  });

  it('retorna un único batch cuando hay exactamente 50 entradas', () => {
    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(`id-${i}`, i));
    const batches = chunkEntriesForSync(entries);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(50);
  });

  it('retorna dos batches cuando hay 51 entradas (ceil(51/50) = 2)', () => {
    const entries = Array.from({ length: 51 }, (_, i) => makeEntry(`id-${i}`, i));
    const batches = chunkEntriesForSync(entries);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(1);
  });

  it('preserva el orden cronológico dentro y entre batches', () => {
    const entries = Array.from({ length: 120 }, (_, i) => makeEntry(`id-${i}`, i));
    const batches = chunkEntriesForSync(entries);
    const flattened = batches.flat();
    expect(flattened.map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('respeta un batchSize personalizado', () => {
    const entries = Array.from({ length: 7 }, (_, i) => makeEntry(`id-${i}`, i));
    const batches = chunkEntriesForSync(entries, 3);
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  /**
   * **Validates: Requirements 13.1**
   *
   * Property 19: Location sync batching — para cualquier conjunto de N entradas
   * no sincronizadas, el mecanismo de sync SHALL producir ceil(N/50) batches,
   * cada uno con a lo sumo 50 entradas, todas en orden cronológico.
   */
  it('produce ceil(N/50) batches de a lo sumo 50 entradas cada uno, en orden', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 300 }),
        (ids) => {
          const uniqueIds = [...new Set(ids)];
          const entries = uniqueIds.map((id, i) => makeEntry(id, i));

          const batches = chunkEntriesForSync(entries);

          expect(batches.length).toBe(Math.ceil(entries.length / LOCATION_SYNC_BATCH_SIZE));
          for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(LOCATION_SYNC_BATCH_SIZE);
          }
          expect(batches.flat().map((e) => e.id)).toEqual(entries.map((e) => e.id));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('filterRelevantAckIds', () => {
  it('retorna solo los IDs presentes tanto en acknowledgedIds como en pendingIds', () => {
    const result = filterRelevantAckIds(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(result).toEqual(['b', 'c']);
  });

  it('retorna un array vacío si no hay coincidencias', () => {
    expect(filterRelevantAckIds(['x', 'y'], ['a', 'b'])).toEqual([]);
  });

  it('retorna un array vacío si pendingIds está vacío', () => {
    expect(filterRelevantAckIds(['a', 'b'], [])).toEqual([]);
  });

  it('retorna un array vacío si acknowledgedIds está vacío', () => {
    expect(filterRelevantAckIds([], ['a', 'b'])).toEqual([]);
  });

  it('ignora acks "perdidos" que no pertenecen al lote en curso', () => {
    // Simula un ack tardío de un batch anterior que ya no está pendiente
    const result = filterRelevantAckIds(['stale-id'], ['current-1', 'current-2']);
    expect(result).toEqual([]);
  });
});
