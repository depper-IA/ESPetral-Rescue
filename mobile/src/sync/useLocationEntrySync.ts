/**
 * CALI Rescue System — Hook de sincronización de entradas de ubicación con ack
 *
 * Transmite entradas no sincronizadas en lotes cronológicos de a lo sumo 50,
 * esperando el acknowledgment del backend antes de enviar el siguiente lote.
 * Nunca marca una entrada como sincronizada sin ack confirmado. Reintenta
 * automáticamente en el próximo evento de conexión si el envío falla.
 *
 * La lógica de batching y matching de acks está extraída a `location-sync.ts`
 * (funciones puras, testeadas por separado) siguiendo el mismo patrón que
 * `audio-processing.ts` / `knock-detection.ts` para `useAudioEngine` / `useKnockDetector`.
 *
 * Requisitos: 13.1, 13.2, 13.3, 13.4, 13.5
 */
import { useCallback, useRef, useState } from 'react';
import type { LocationEngine } from '../location/location-engine';
import type { ConnectionState, LocationSyncAck, SyncEngine } from './sync-engine';
import { chunkEntriesForSync, filterRelevantAckIds, LOCATION_SYNC_BATCH_SIZE } from './location-sync';

/** Tipo de mensaje para el envío de batches de ubicación */
const SYNC_ENTRIES_TYPE = 'cali/sync/entries';

export interface UseLocationEntrySyncResult {
  /** true mientras hay un lote en tránsito esperando ack */
  isSyncing: boolean;
  /** Debe invocarse cuando cambia el estado de conexión del SyncEngine */
  handleConnectionStateChange: (state: ConnectionState) => void;
  /** Debe invocarse cuando el SyncEngine recibe un `cali/sync/ack` */
  handleSyncAck: (ack: LocationSyncAck) => void;
  /** Fuerza un intento de envío inmediato (p. ej. tras registrar una entrada nueva) */
  triggerSync: () => void;
}

/**
 * Coordina el envío de entradas de ubicación no sincronizadas hacia el backend.
 */
export function useLocationEntrySync(
  engine: LocationEngine,
  sync: SyncEngine,
  deviceToken: string,
): UseLocationEntrySyncResult {
  const [isSyncing, setIsSyncing] = useState(false);
  const isSyncingRef = useRef(false);
  const pendingIdsRef = useRef<string[] | null>(null);

  const sendNextBatch = useCallback((): void => {
    // Nunca solapar envíos: esperar el ack del lote en curso antes de continuar
    if (isSyncingRef.current) return;
    if (sync.getConnectionState() !== 'connected') return;

    const unsynced = engine.getUnsyncedEntries();
    if (unsynced.length === 0) return;

    const [batch] = chunkEntriesForSync(unsynced, LOCATION_SYNC_BATCH_SIZE);

    const sent = sync.send(SYNC_ENTRIES_TYPE, { entries: batch, device_token: deviceToken });
    if (!sent) {
      // Falla de envío: no se marca nada como pendiente — se reintentará
      // en el próximo evento de conexión (handleConnectionStateChange).
      return;
    }

    pendingIdsRef.current = batch.map((entry) => entry.id);
    isSyncingRef.current = true;
    setIsSyncing(true);
  }, [deviceToken, engine, sync]);

  const handleSyncAck = useCallback(
    (ack: LocationSyncAck): void => {
      // Ignorar acks que no corresponden a un lote en curso (p. ej. llegados
      // fuera de orden tras una reconexión)
      if (!pendingIdsRef.current) return;

      const relevantIds = filterRelevantAckIds(ack.acknowledged_ids ?? [], pendingIdsRef.current);

      pendingIdsRef.current = null;
      isSyncingRef.current = false;
      setIsSyncing(false);

      if (relevantIds.length > 0) {
        // markSynced solo se llama con IDs confirmados por el backend —
        // nunca se borran ni marcan entradas sin ack (Req 13.5)
        void engine.markSynced(relevantIds);
      }

      // Encadenar el siguiente lote si quedan entradas pendientes
      sendNextBatch();
    },
    [engine, sendNextBatch],
  );

  const handleConnectionStateChange = useCallback(
    (state: ConnectionState): void => {
      if (state === 'connected') {
        sendNextBatch();
      }
    },
    [sendNextBatch],
  );

  return {
    isSyncing,
    handleConnectionStateChange,
    handleSyncAck,
    triggerSync: sendNextBatch,
  };
}
