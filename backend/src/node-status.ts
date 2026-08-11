/**
 * ESPetral Rescue — Lógica de estado de nodos ESP32
 *
 * Módulo compartido que implementa la clasificación online/offline
 * de nodos basada en timeout de 30 segundos sin mensajes.
 *
 * Property 9: Node is offline if (current_timestamp - last_seen) > 30 seconds
 * Requisitos: 7.5, 7.6
 */

/** Tiempo máximo sin mensaje para considerar un nodo offline (30 segundos) */
export const NODE_OFFLINE_TIMEOUT_MS = 30_000;

/** Intervalo de verificación de estado de nodos (5 segundos) */
export const NODE_CHECK_INTERVAL_MS = 5_000;

/** Estado de un nodo ESP32 */
export interface NodeState {
  node_id: string;
  zone_id: string;
  /** Timestamp (ms) del último mensaje recibido del nodo */
  lastSeen: number;
  /** Si el nodo se considera actualmente en línea */
  online: boolean;
}

/**
 * Determina si un nodo está online basado en su último timestamp visto
 * y el timestamp actual.
 *
 * Property 9: Un nodo está offline si y solo si
 * (current_timestamp - last_seen_timestamp) > 30 segundos.
 *
 * @param lastSeenMs - Timestamp en ms de la última vez que se recibió mensaje del nodo
 * @param currentMs - Timestamp actual en ms
 * @returns true si el nodo debe considerarse online, false si offline
 */
export function isNodeOnline(lastSeenMs: number, currentMs: number): boolean {
  const elapsed = currentMs - lastSeenMs;
  return elapsed <= NODE_OFFLINE_TIMEOUT_MS;
}

/**
 * Evalúa el estado de todos los nodos y retorna los que cambiaron a offline.
 *
 * @param nodes - Mapa de nodos con su estado actual
 * @param currentMs - Timestamp actual en ms
 * @returns Array de node_ids que cambiaron de online a offline
 */
export function checkNodeTimeouts(
  nodes: Map<string, NodeState>,
  currentMs: number
): string[] {
  const changedToOffline: string[] = [];

  for (const [nodeId, node] of nodes) {
    const shouldBeOnline = isNodeOnline(node.lastSeen, currentMs);

    if (node.online && !shouldBeOnline) {
      node.online = false;
      changedToOffline.push(nodeId);
    }
  }

  return changedToOffline;
}
