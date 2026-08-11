/**
 * CALI Rescue System — Tests para estado de nodos ESP32
 *
 * Feature: cali-rescue-system, Property 9: Node online/offline classification
 * Requisitos: 7.5, 7.6
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isNodeOnline,
  checkNodeTimeouts,
  NODE_OFFLINE_TIMEOUT_MS,
  type NodeState,
} from './node-status.js';

describe('Node status — isNodeOnline', () => {
  /**
   * **Validates: Requirements 7.5**
   * Property 9: Un nodo está offline si y solo si
   * (current_timestamp - last_seen_timestamp) > 30 segundos.
   */
  it('classifica nodo como online cuando elapsed <= 30s y offline cuando > 30s', () => {
    fc.assert(
      fc.property(
        // lastSeen: cualquier timestamp positivo
        fc.nat({ max: 1_000_000_000 }),
        // elapsed: tiempo transcurrido desde lastSeen (0 a 120 segundos)
        fc.nat({ max: 120_000 }),
        (lastSeen, elapsed) => {
          const current = lastSeen + elapsed;
          const result = isNodeOnline(lastSeen, current);

          if (elapsed <= NODE_OFFLINE_TIMEOUT_MS) {
            // Debería estar online: elapsed <= 30s
            expect(result).toBe(true);
          } else {
            // Debería estar offline: elapsed > 30s
            expect(result).toBe(false);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('nodo en el límite exacto (30000ms) está online', () => {
    const lastSeen = 1000000;
    const current = lastSeen + NODE_OFFLINE_TIMEOUT_MS; // exactamente 30s
    expect(isNodeOnline(lastSeen, current)).toBe(true);
  });

  it('nodo 1ms después del timeout está offline', () => {
    const lastSeen = 1000000;
    const current = lastSeen + NODE_OFFLINE_TIMEOUT_MS + 1;
    expect(isNodeOnline(lastSeen, current)).toBe(false);
  });

  it('nodo con lastSeen === currentMs está online (elapsed = 0)', () => {
    const ts = 5000000;
    expect(isNodeOnline(ts, ts)).toBe(true);
  });
});

describe('Node status — checkNodeTimeouts', () => {
  it('marca como offline los nodos que excedieron 30s sin mensaje', () => {
    const now = 100_000;
    const nodes = new Map<string, NodeState>([
      ['node-a', { node_id: 'node-a', zone_id: 'z1', lastSeen: now - 31_000, online: true }],
      ['node-b', { node_id: 'node-b', zone_id: 'z2', lastSeen: now - 10_000, online: true }],
      ['node-c', { node_id: 'node-c', zone_id: 'z1', lastSeen: now - 60_000, online: true }],
    ]);

    const changed = checkNodeTimeouts(nodes, now);

    expect(changed).toContain('node-a');
    expect(changed).toContain('node-c');
    expect(changed).not.toContain('node-b');
    expect(nodes.get('node-a')!.online).toBe(false);
    expect(nodes.get('node-b')!.online).toBe(true);
    expect(nodes.get('node-c')!.online).toBe(false);
  });

  it('no cambia nodos que ya estaban offline', () => {
    const now = 200_000;
    const nodes = new Map<string, NodeState>([
      ['node-x', { node_id: 'node-x', zone_id: 'z1', lastSeen: now - 50_000, online: false }],
    ]);

    const changed = checkNodeTimeouts(nodes, now);

    expect(changed).toHaveLength(0);
    expect(nodes.get('node-x')!.online).toBe(false);
  });

  /**
   * **Validates: Requirements 7.6**
   * Verifica que con intervalo de 5s, un nodo offline se detecta
   * dentro de 5s de la expiración del timeout.
   */
  it('detecta offline dentro de 5s del timeout (simulación de intervalos)', () => {
    fc.assert(
      fc.property(
        // lastSeen base
        fc.nat({ max: 1_000_000 }),
        (baseTime) => {
          const lastSeen = baseTime;
          const nodes = new Map<string, NodeState>([
            ['node-1', { node_id: 'node-1', zone_id: 'z1', lastSeen, online: true }],
          ]);

          // Simular verificaciones cada 5 segundos
          const checkInterval = 5_000;
          let detected = false;
          let detectionTime = 0;

          for (let tick = 0; tick <= 40_000; tick += checkInterval) {
            const currentTime = lastSeen + tick;
            const changed = checkNodeTimeouts(nodes, currentTime);

            if (changed.includes('node-1')) {
              detected = true;
              detectionTime = tick;
              break;
            }
          }

          // El nodo DEBE ser detectado como offline
          expect(detected).toBe(true);

          // El tiempo de detección debe ser <= timeout + checkInterval (35s)
          // (Es decir, dentro de 5s después de que expire el timeout de 30s)
          expect(detectionTime).toBeLessThanOrEqual(NODE_OFFLINE_TIMEOUT_MS + checkInterval);
          expect(detectionTime).toBeGreaterThan(NODE_OFFLINE_TIMEOUT_MS);
        }
      ),
      { numRuns: 100 }
    );
  });
});
