/**
 * ESPetral Rescue — Tests del motor de sincronización WebSocket
 *
 * Incluye tests unitarios y property-based tests para el SyncEngine.
 * Requisitos validados: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { SyncEngine, type ZoneAlert, type SyncEngineOptions, type LocationSyncAck } from './sync-engine.js';

// --- Mock de WebSocket global ---

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private static instances: MockWebSocket[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  // Helpers para simular eventos en tests
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  static getLastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static clearInstances(): void {
    MockWebSocket.instances = [];
  }
}

// --- Helpers ---

function defaultOptions(overrides?: Partial<SyncEngineOptions>): SyncEngineOptions {
  return {
    url: 'ws://localhost:9001',
    connectionTimeout: 5000,
    retryInterval: 5000,
    maxRetries: 10,
    maxAlerts: 50,
    ...overrides,
  };
}

function createCsiMessage(zoneId: string, probability: number, timestamp?: string): string {
  return JSON.stringify({
    type: `cali/zone/${zoneId}/csi`,
    payload: {
      zone_id: zoneId,
      motion_probability: probability,
      node_id: 'node-01',
      timestamp: timestamp ?? new Date().toISOString(),
    },
  });
}

// --- Tests unitarios ---

describe('SyncEngine', () => {
  let engine: SyncEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.clearInstances();
  });

  afterEach(() => {
    engine?.disconnect();
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).WebSocket;
  });

  describe('Conexión inicial (Req 8.1)', () => {
    it('debe intentar conexión WebSocket al URL configurado', () => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws!.url).toBe('ws://localhost:9001');
    });

    it('debe cambiar estado a connecting durante la conexión', () => {
      engine = new SyncEngine(defaultOptions());
      const states: string[] = [];
      engine.setListener({ onConnectionStateChange: (s) => states.push(s) });

      engine.connect();
      expect(engine.getConnectionState()).toBe('connecting');
      expect(states).toContain('connecting');
    });

    it('debe cambiar estado a connected cuando el socket abre', () => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      expect(engine.getConnectionState()).toBe('connected');
    });

    it('debe timeout a los 5 segundos si no conecta', () => {
      engine = new SyncEngine(defaultOptions({ connectionTimeout: 5000 }));
      engine.connect();

      expect(engine.getConnectionState()).toBe('connecting');

      vi.advanceTimersByTime(5000);

      expect(engine.getConnectionState()).toBe('disconnected');
    });
  });

  describe('Recepción de alertas CSI (Req 8.2)', () => {
    beforeEach(() => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();
      MockWebSocket.getLastInstance()!.simulateOpen();
    });

    it('debe procesar mensajes CSI y agregar al buffer de alertas', () => {
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateMessage(createCsiMessage('zone-A', 0.75));

      const alerts = engine.getAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].zone_id).toBe('zone-A');
      expect(alerts[0].motion_probability).toBe(0.75);
    });

    it('debe invocar onAlert del listener', () => {
      const alertSpy = vi.fn();
      engine.setListener({ onAlert: alertSpy });

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateMessage(createCsiMessage('zone-B', 0.5));

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ zone_id: 'zone-B', motion_probability: 0.5 })
      );
    });

    it('debe retener máximo 50 alertas (las más recientes)', () => {
      const ws = MockWebSocket.getLastInstance()!;

      for (let i = 0; i < 60; i++) {
        ws.simulateMessage(createCsiMessage(`zone-${i}`, 0.5, `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`));
      }

      const alerts = engine.getAlerts();
      expect(alerts).toHaveLength(50);
      // La más reciente es la última insertada (zone-59)
      expect(alerts[0].zone_id).toBe('zone-59');
    });

    it('debe ignorar mensajes con JSON inválido', () => {
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateMessage('esto no es json{{{');

      expect(engine.getAlerts()).toHaveLength(0);
    });

    it('debe ignorar mensajes que no son del patrón cali/zone/+/csi', () => {
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateMessage(JSON.stringify({
        type: 'cali/sync/ack',
        payload: { acknowledged_ids: ['abc'] },
      }));

      expect(engine.getAlerts()).toHaveLength(0);
    });

    it('debe extraer zone_id del tópico si no está en el payload', () => {
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateMessage(JSON.stringify({
        type: 'cali/zone/zone-X/csi',
        payload: { motion_probability: 0.8, node_id: 'n1', timestamp: '2024-01-01T00:00:00Z' },
      }));

      expect(engine.getAlerts()[0].zone_id).toBe('zone-X');
    });
  });

  describe('Reintentos de conexión (Req 8.3)', () => {
    it('debe reintentar cada 5 segundos al perder conexión', () => {
      engine = new SyncEngine(defaultOptions({ retryInterval: 5000 }));
      engine.connect();

      const ws1 = MockWebSocket.getLastInstance()!;
      ws1.simulateOpen();
      ws1.simulateClose();

      expect(engine.getConnectionState()).toBe('disconnected');

      vi.advanceTimersByTime(5000);

      // Debió crear un nuevo socket
      const ws2 = MockWebSocket.getLastInstance()!;
      expect(ws2).not.toBe(ws1);
      expect(engine.getConnectionState()).toBe('connecting');
    });

    it('debe mostrar indicador offline persistente después de 10 intentos fallidos', () => {
      engine = new SyncEngine(defaultOptions({
        retryInterval: 100,
        connectionTimeout: 50,
        maxRetries: 10,
      }));
      const offlineSpy = vi.fn();
      engine.setListener({ onPersistentOffline: offlineSpy });

      engine.connect();

      // Simular 10 fallos de timeout
      for (let i = 0; i < 11; i++) {
        vi.advanceTimersByTime(50); // timeout
        vi.advanceTimersByTime(100); // retry interval
      }

      expect(engine.isPersistentOffline()).toBe(true);
      expect(offlineSpy).toHaveBeenCalledWith(true);
    });
  });

  describe('Reconexión automática (Req 8.5)', () => {
    it('debe remover indicador offline al reconectar exitosamente', () => {
      engine = new SyncEngine(defaultOptions({
        retryInterval: 100,
        connectionTimeout: 50,
        maxRetries: 2,
      }));
      const offlineSpy = vi.fn();
      engine.setListener({ onPersistentOffline: offlineSpy });

      engine.connect();

      // Primer intento: timeout (retryCount → 1)
      vi.advanceTimersByTime(50);
      // Esperar retry interval para segundo intento
      vi.advanceTimersByTime(100);

      // Segundo intento: timeout (retryCount → 2, offline = true)
      vi.advanceTimersByTime(50);

      expect(engine.isPersistentOffline()).toBe(true);

      // Esperar retry interval para tercer intento (sigue intentando aunque offline)
      vi.advanceTimersByTime(100);

      // Simular conexión exitosa en el tercer intento
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      expect(engine.isPersistentOffline()).toBe(false);
      expect(offlineSpy).toHaveBeenCalledWith(false);
      expect(engine.getConnectionState()).toBe('connected');
    });

    it('debe resetear contador de reintentos al conectar exitosamente', () => {
      engine = new SyncEngine(defaultOptions({ retryInterval: 100, connectionTimeout: 50 }));
      engine.connect();

      // Fallar un par de veces
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(100);

      // Conectar exitosamente
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      expect(engine.getRetryCount()).toBe(0);
    });
  });

  describe('Funcionalidad local sin conexión (Req 8.4)', () => {
    it('no debe crashear ni bloquear la app cuando está desconectado', () => {
      engine = new SyncEngine(defaultOptions());
      // No llamamos connect — simulando sin red
      expect(engine.getConnectionState()).toBe('disconnected');
      expect(engine.getAlerts()).toEqual([]);
      expect(engine.send('test', {})).toBe(false);
    });
  });

  describe('Envío de mensajes', () => {
    it('debe enviar mensaje JSON cuando está conectado', () => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();
      MockWebSocket.getLastInstance()!.simulateOpen();

      const result = engine.send('cali/sync/entries', { entries: [], device_token: 'abc' });
      expect(result).toBe(true);
      expect(MockWebSocket.getLastInstance()!.send).toHaveBeenCalled();
    });

    it('debe retornar false cuando no está conectado', () => {
      engine = new SyncEngine(defaultOptions());
      const result = engine.send('cali/sync/entries', { entries: [] });
      expect(result).toBe(false);
    });
  });

  describe('Recepción de acknowledgment de sync (Req 13.2, 13.5)', () => {
    beforeEach(() => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();
      MockWebSocket.getLastInstance()!.simulateOpen();
    });

    it('debe invocar onSyncAck con los IDs confirmados al recibir cali/sync/ack', () => {
      const ackSpy = vi.fn();
      engine.setListener({ onSyncAck: ackSpy });

      const ack: LocationSyncAck = { acknowledged_ids: ['id-1', 'id-2'], errors: [] };
      MockWebSocket.getLastInstance()!.simulateMessage(
        JSON.stringify({ type: 'cali/sync/ack', payload: ack }),
      );

      expect(ackSpy).toHaveBeenCalledWith(ack);
    });

    it('debe pasar un array vacío de errores si el payload no lo incluye', () => {
      const ackSpy = vi.fn();
      engine.setListener({ onSyncAck: ackSpy });

      MockWebSocket.getLastInstance()!.simulateMessage(
        JSON.stringify({ type: 'cali/sync/ack', payload: { acknowledged_ids: ['id-1'] } }),
      );

      expect(ackSpy).toHaveBeenCalledWith({ acknowledged_ids: ['id-1'], errors: [] });
    });

    it('no debe invocar onAlert cuando llega un ack (no es un mensaje CSI)', () => {
      const alertSpy = vi.fn();
      engine.setListener({ onAlert: alertSpy });

      MockWebSocket.getLastInstance()!.simulateMessage(
        JSON.stringify({ type: 'cali/sync/ack', payload: { acknowledged_ids: [] } }),
      );

      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('no debe lanzar error si no hay listener onSyncAck registrado', () => {
      engine.setListener({});
      expect(() => {
        MockWebSocket.getLastInstance()!.simulateMessage(
          JSON.stringify({ type: 'cali/sync/ack', payload: { acknowledged_ids: [] } }),
        );
      }).not.toThrow();
    });

    it('debe ignorar acks con payload malformado sin lanzar error', () => {
      const ackSpy = vi.fn();
      engine.setListener({ onSyncAck: ackSpy });

      expect(() => {
        MockWebSocket.getLastInstance()!.simulateMessage(
          JSON.stringify({ type: 'cali/sync/ack', payload: null }),
        );
      }).not.toThrow();
      expect(ackSpy).not.toHaveBeenCalled();
    });
  });

  describe('Cierre controlado', () => {
    it('debe detener reintentos al llamar disconnect()', () => {
      engine = new SyncEngine(defaultOptions({ retryInterval: 100, connectionTimeout: 50 }));
      engine.connect();

      vi.advanceTimersByTime(50); // timeout
      engine.disconnect();

      // No debería reconectar
      vi.advanceTimersByTime(1000);
      expect(engine.getConnectionState()).toBe('disconnected');
    });

    it('no debe reconectar si se cierra intencionalmente', () => {
      engine = new SyncEngine(defaultOptions());
      engine.connect();
      MockWebSocket.getLastInstance()!.simulateOpen();

      engine.disconnect();
      expect(engine.getConnectionState()).toBe('disconnected');

      vi.advanceTimersByTime(10000);
      expect(engine.getConnectionState()).toBe('disconnected');
    });
  });
});

// --- Property-Based Tests ---

describe('SyncEngine — Property-Based Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.clearInstances();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).WebSocket;
  });

  /**
   * **Validates: Requirements 8.2**
   *
   * Property 10: Alert buffer bounded at 50 — never exceeds 50 entries,
   * always contains the 50 most recent alerts.
   */
  it('el buffer de alertas nunca excede 50 entradas y siempre contiene las 50 más recientes', () => {
    fc.assert(
      fc.property(
        // Generar entre 1 y 200 alertas con timestamps distintos
        fc.array(
          fc.record({
            zone_id: fc.stringMatching(/^[a-z0-9-]{1,20}$/),
            motion_probability: fc.double({ min: 0, max: 1, noNaN: true }),
            timestamp_offset: fc.nat({ max: 100000 }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (alertInputs) => {
          const engine = new SyncEngine(defaultOptions({ maxAlerts: 50 }));
          engine.connect();
          const ws = MockWebSocket.getLastInstance()!;
          ws.simulateOpen();

          const baseTime = Date.now();
          const sentAlerts: ZoneAlert[] = [];

          for (const input of alertInputs) {
            const timestamp = new Date(baseTime + input.timestamp_offset).toISOString();
            const msg = JSON.stringify({
              type: `cali/zone/${input.zone_id}/csi`,
              payload: {
                zone_id: input.zone_id,
                motion_probability: input.motion_probability,
                node_id: 'test-node',
                timestamp,
              },
            });

            ws.simulateMessage(msg);
            sentAlerts.push({
              zone_id: input.zone_id,
              motion_probability: input.motion_probability,
              timestamp,
            });
          }

          const buffer = engine.getAlerts();

          // Propiedad 1: Nunca excede 50
          expect(buffer.length).toBeLessThanOrEqual(50);

          // Propiedad 2: Contiene las 50 más recientes (en orden de inserción, más reciente primero)
          const expected = sentAlerts.slice(-50).reverse();
          expect(buffer.length).toBe(expected.length);

          for (let i = 0; i < buffer.length; i++) {
            expect(buffer[i].zone_id).toBe(expected[i].zone_id);
            expect(buffer[i].motion_probability).toBe(expected[i].motion_probability);
            expect(buffer[i].timestamp).toBe(expected[i].timestamp);
          }

          engine.disconnect();
        },
      ),
      { numRuns: 100 },
    );
  });
});
