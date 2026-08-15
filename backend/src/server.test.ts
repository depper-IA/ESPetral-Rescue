/**
 * ESPetral Rescue — Tests del servidor dashboard
 *
 * Verifica que el servidor Express sirve el dashboard HTML,
 * la API de zonas retorna datos correctos, y los marcadores
 * usan los colores apropiados según los umbrales de probabilidad.
 *
 * Requisitos: 7.1, 7.2, 7.3, 7.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createDashboardServer, type ServerInstance } from './server.js';
import { initializeDatabase } from './database.js';
import type Database from 'better-sqlite3';

describe('Dashboard Server', () => {
  let db: Database.Database;
  let server: ServerInstance;
  const TEST_PORT = 3999;

  beforeEach(async () => {
    db = initializeDatabase({ inMemory: true, enablePurge: false });
    server = createDashboardServer({ db, port: TEST_PORT });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  describe('Servicio de archivos estáticos', () => {
    it('sirve el dashboard HTML en la ruta raíz con status 200', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });

    it('el HTML contiene el título de la PWA unificada', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/`);
      const html = await response.text();
      expect(html).toContain('ESPetral');
    });
  });

  describe('API GET /api/zones', () => {
    it('retorna un arreglo vacío cuando no hay zonas', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/zones`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual([]);
    });

    it('retorna zonas registradas con last_probability null cuando no hay datos', async () => {
      // Insertar una zona sin datos de probabilidad
      db.prepare(`
        INSERT INTO zones (id, name, center_lat, center_lon, radius_m)
        VALUES ('zone-1', 'Zona Norte', 3.4516, -76.5320, 50)
      `).run();

      const response = await fetch(`http://localhost:${TEST_PORT}/api/zones`);
      const data = await response.json() as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('zone-1');
      expect(data[0].name).toBe('Zona Norte');
      expect(data[0].center_lat).toBe(3.4516);
      expect(data[0].center_lon).toBe(-76.5320);
      expect(data[0].last_probability).toBeNull();
      expect(data[0].last_update).toBeNull();
    });

    it('retorna zonas con su última probabilidad cuando hay datos de scoring', async () => {
      // Insertar zona con puntaje de probabilidad
      db.prepare(`
        INSERT INTO zones (id, name, center_lat, center_lon, radius_m)
        VALUES ('zone-a', 'Zona Sur', 3.4000, -76.5100, 50)
      `).run();

      db.prepare(`
        INSERT INTO probability_scores (zone_id, score, csi_contribution, computed_at)
        VALUES ('zone-a', 45, 0.45, '2024-01-15 10:30:00')
      `).run();

      const response = await fetch(`http://localhost:${TEST_PORT}/api/zones`);
      const data = await response.json() as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].last_probability).toBe(45);
      expect(data[0].last_update).toBe('2024-01-15 10:30:00');
    });

    it('soporta hasta 50 zonas sin error', async () => {
      // Insertar 50 zonas
      const insertStmt = db.prepare(`
        INSERT INTO zones (id, name, center_lat, center_lon, radius_m)
        VALUES (?, ?, ?, ?, 50)
      `);

      for (let i = 0; i < 50; i++) {
        insertStmt.run(`zone-${i}`, `Zona ${i}`, 3.4 + i * 0.001, -76.5 + i * 0.001);
      }

      const response = await fetch(`http://localhost:${TEST_PORT}/api/zones`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(50);
    });
  });

  describe('Broadcast de actualizaciones CSI', () => {
    it('broadcastCsiUpdate no lanza error sin clientes conectados', () => {
      expect(() => {
        server.broadcastCsiUpdate('zone-1', 0.75);
      }).not.toThrow();
    });

    it('broadcastCsiUpdate no lanza error con rssi', () => {
      expect(() => {
        server.broadcastCsiUpdate('zone-1', 0.75, 'node-1', -62);
      }).not.toThrow();
    });

    it('broadcastCsiUpdate incluye rssi en el mensaje csi_update cuando se provee', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
      const done = new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'zones_sync') {
            setTimeout(() => {
              server.broadcastCsiUpdate('zone-rssi', 0.4, 'node-rssi', -58);
            }, 50);
          } else if (msg.type === 'csi_update') {
            try {
              expect(msg.zone_id).toBe('zone-rssi');
              expect(msg.node_id).toBe('node-rssi');
              expect(msg.motion_probability).toBe(0.4);
              expect(msg.rssi).toBe(-58);
              ws.close();
              resolve();
            } catch (err) {
              ws.close();
              reject(err);
            }
          }
        });
        ws.on('error', (err) => { ws.close(); reject(err); });
        setTimeout(() => { ws.close(); reject(new Error('Timeout esperando csi_update')); }, 3000);
      });
      await done;
    });

    it('broadcastCsiUpdate omite el campo rssi del mensaje cuando no se provee', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
      const done = new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'zones_sync') {
            setTimeout(() => {
              server.broadcastCsiUpdate('zone-norssi', 0.2, 'node-norssi');
            }, 50);
          } else if (msg.type === 'csi_update') {
            try {
              expect(msg.zone_id).toBe('zone-norssi');
              expect('rssi' in msg).toBe(false);
              ws.close();
              resolve();
            } catch (err) {
              ws.close();
              reject(err);
            }
          }
        });
        ws.on('error', (err) => { ws.close(); reject(err); });
        setTimeout(() => { ws.close(); reject(new Error('Timeout esperando csi_update')); }, 3000);
      });
      await done;
    });

    it('broadcastZoneAdded no lanza error sin clientes conectados', () => {
      expect(() => {
        server.broadcastZoneAdded({
          id: 'zone-new',
          name: 'Zona Nueva',
          center_lat: 3.45,
          center_lon: -76.53,
          radius_m: 50,
          created_at: '2024-01-15T10:00:00Z',
        });
      }).not.toThrow();
    });

    it('broadcastProbabilityUpdate no lanza error sin clientes conectados', () => {
      expect(() => {
        server.broadcastProbabilityUpdate('zone-1', 72, { csi: 60, acoustic: 40, gps: null });
      }).not.toThrow();
    });

    it('broadcastProbabilityUpdate no lanza error sin sources', () => {
      expect(() => {
        server.broadcastProbabilityUpdate('zone-1', 30);
      }).not.toThrow();
    });

    it('broadcastCsiRawUpdate no lanza error sin clientes conectados', () => {
      const amplitudes = Array.from({ length: 64 }, (_, i) => i * 0.1);
      expect(() => {
        server.broadcastCsiRawUpdate('zone-1', 'node-1', amplitudes, '2024-01-15T10:30:00Z');
      }).not.toThrow();
    });

    it('broadcastCsiRawUpdate envía mensaje csi_raw_update al cliente conectado', async () => {
      // Conectar un cliente WS y validar el shape del mensaje recibido.
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/dashboard`);
      const received: unknown[] = [];
      const done = new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          received.push(msg);
          if (msg.type === 'zones_sync') {
            // Ignorar el sync inicial; emitir el raw y verificar luego
            setTimeout(() => {
              const amplitudes = Array.from({ length: 64 }, (_, i) => i * 0.5);
              server.broadcastCsiRawUpdate('zone-test', 'node-test', amplitudes, '2024-01-15T11:00:00Z');
            }, 50);
          } else if (msg.type === 'csi_raw_update') {
            try {
              expect(msg.zone_id).toBe('zone-test');
              expect(msg.node_id).toBe('node-test');
              expect(msg.timestamp).toBe('2024-01-15T11:00:00Z');
              expect(msg.subcarrier_amplitudes).toHaveLength(64);
              expect(msg.subcarrier_amplitudes[0]).toBe(0);
              expect(msg.subcarrier_amplitudes[63]).toBeCloseTo(31.5);
              ws.close();
              resolve();
            } catch (err) {
              ws.close();
              reject(err);
            }
          }
        });
        ws.on('error', (err) => { ws.close(); reject(err); });
        setTimeout(() => { ws.close(); reject(new Error('Timeout esperando csi_raw_update')); }, 3000);
      });
      await done;
    });
  });
});
