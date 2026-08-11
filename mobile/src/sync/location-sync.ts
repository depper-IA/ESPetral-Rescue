/**
 * CALI Rescue System — Funciones puras de sincronización de entradas de ubicación
 *
 * Extraídas para facilitar property-based testing, siguiendo el mismo patrón
 * usado en `audio-processing.ts` y `knock-detection.ts`.
 *
 * Requisitos: 13.1, 13.2, 13.5
 */
import type { LocationEntry } from '../location/location-engine';

/** Máximo de entradas por batch de sincronización (Req 13.1) */
export const LOCATION_SYNC_BATCH_SIZE = 50;

/**
 * Divide las entradas no sincronizadas en lotes cronológicos de a lo sumo
 * `batchSize` elementos, preservando el orden recibido.
 *
 * Feature: cali-rescue-system, Property 19: Location sync batching
 */
export function chunkEntriesForSync(
  entries: LocationEntry[],
  batchSize: number = LOCATION_SYNC_BATCH_SIZE,
): LocationEntry[][] {
  if (entries.length === 0) return [];

  const batches: LocationEntry[][] = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Filtra los IDs reconocidos por el backend que pertenecen al lote enviado
 * actualmente. Descarta acks "perdidos" (IDs que no forman parte del lote
 * en curso), evitando marcar como sincronizadas entradas que no se enviaron.
 */
export function filterRelevantAckIds(acknowledgedIds: string[], pendingIds: string[]): string[] {
  const pendingSet = new Set(pendingIds);
  return acknowledgedIds.filter((id) => pendingSet.has(id));
}
