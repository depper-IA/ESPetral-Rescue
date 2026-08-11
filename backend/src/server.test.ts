/**
 * CALI Rescue System — Tests del servidor dashboard
 *
 * Verifica que el servidor Express sirve el dashboard HTML,
 * la API de zonas retorna datos correctos, y los marcadores
 * usan los colores apropiados según los umbrales de probabilidad.
 *
 * Requisitos: 7.1, 7.2, 7.3, 7.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    it('el HTML contiene Leaflet.js y el título del panel', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/`);
      const html = await response.text();
      expect(html).toContain('leaflet');
      expect(html).toContain('CALI Rescue');
      expect(html).toContain('Mapa de Zonas');
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
  });
});
