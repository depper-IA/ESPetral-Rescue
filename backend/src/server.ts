/**
 * CALI Rescue System — Servidor Express + Dashboard
 *
 * Sirve el panel de control estático en el puerto 3000 y expone
 * una API REST para consultar zonas registradas. También provee
 * un endpoint WebSocket (/ws/dashboard) para actualizaciones en
 * tiempo real de telemetría CSI hacia los clientes del dashboard.
 *
 * Requisitos: 7.1, 7.2, 7.3, 7.4
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Ruta al directorio de archivos estáticos del dashboard */
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** Puerto por defecto para el servidor HTTP del dashboard */
export const DEFAULT_PORT = 3000;

/** Opciones para inicializar el servidor */
export interface ServerOptions {
  /** Instancia de la base de datos SQLite */
  db: Database.Database;
  /** Puerto HTTP (por defecto: 3000) */
  port?: number;
}

/** Entrada de ubicación sincronizada para mostrar como reporte de campo */
export interface FieldReportEntry {
  id: string;
  lat: number;
  lon: number;
  note: string;
  captured_at: string;
}

/** Instancia del servidor con métodos para control externo */
export interface ServerInstance {
  /** Aplicación Express */
  app: express.Application;
  /** Servidor HTTP subyacente */
  httpServer: Server;
  /** WebSocket server para clientes del dashboard */
  wss: WebSocketServer;
  /** Inicia el servidor en el puerto configurado */
  start(): Promise<void>;
  /** Detiene el servidor de forma limpia */
  stop(): Promise<void>;
  /** Envía una actualización de telemetría CSI a todos los clientes del dashboard */
  broadcastCsiUpdate(zoneId: string, motionProbability: number, nodeId?: string): void;
  /** Envía una nueva zona a todos los clientes del dashboard */
  broadcastZoneAdded(zone: ZoneRow): void;
  /** Envía una entrada de ubicación sincronizada como reporte de campo al dashboard */
  broadcastFieldReport(entry: FieldReportEntry): void;
  /** Envía actualización de estado de un nodo ESP32 (online/offline) al dashboard */
  broadcastNodeStatus(nodeId: string, zoneId: string, status: 'online' | 'offline'): void;
  /** Envía el score compuesto de probabilidad recién calculado (CSI + acústico + GPS) al dashboard */
  broadcastProbabilityUpdate(
    zoneId: string,
    probability: number,
    sources?: { csi: number | null; acoustic: number | null; gps: number | null },
  ): void;
}

/** Fila de zona tal como se almacena en SQLite */
interface ZoneRow {
  id: string;
  name: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  created_at: string;
}

/** Zona con datos de probabilidad para la respuesta API */
interface ZoneWithProbability extends ZoneRow {
  last_probability: number | null;
  last_update: string | null;
}

/**
 * Crea e inicializa el servidor Express con el dashboard y API.
 *
 * @param options - Configuración del servidor
 * @returns Instancia del servidor lista para iniciar
 */
export function createDashboardServer(options: ServerOptions): ServerInstance {
  const { db, port = DEFAULT_PORT } = options;

  const app = express();

  // Servir archivos estáticos del dashboard
  app.use(express.static(PUBLIC_DIR));

  // --- API REST ---

  /**
   * GET /api/zones
   * Retorna todas las zonas registradas con su última probabilidad y timestamp.
   * Las zonas sin datos de probabilidad retornan last_probability: null.
   */
  app.get('/api/zones', (_req, res) => {
    try {
      const zones = getZonesWithProbability(db);
      res.json(zones);
    } catch (err) {
      console.error('[server] Error al consultar zonas:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // --- Servidor HTTP ---
  const httpServer = createServer(app);

  // --- WebSocket para dashboard ---
  const wss = new WebSocketServer({ noServer: true });

  // Manejar upgrade de conexión solo para /ws/dashboard
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/dashboard') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Al conectarse un cliente del dashboard, enviar estado actual de zonas y reportes de campo
  wss.on('connection', (ws) => {
    try {
      const zones = getZonesWithProbability(db);
      ws.send(JSON.stringify({ type: 'zones_sync', zones }));

      // Enviar reportes de campo existentes (ubicaciones sincronizadas)
      const fieldReports = getFieldReports(db);
      if (fieldReports.length > 0) {
        ws.send(JSON.stringify({ type: 'field_reports_sync', entries: fieldReports }));
      }
    } catch (err) {
      console.error('[server] Error al enviar datos iniciales al cliente WS:', err);
    }
  });

  // --- Métodos de broadcast ---

  function broadcastCsiUpdate(zoneId: string, motionProbability: number, nodeId?: string): void {
    const message = JSON.stringify({
      type: 'csi_update',
      zone_id: zoneId,
      motion_probability: motionProbability,
      ...(nodeId && { node_id: nodeId }),
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  function broadcastZoneAdded(zone: ZoneRow): void {
    const message = JSON.stringify({
      type: 'zone_added',
      zone,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  function broadcastFieldReport(entry: FieldReportEntry): void {
    const message = JSON.stringify({
      type: 'field_report',
      entry,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  function broadcastNodeStatus(nodeId: string, zoneId: string, status: 'online' | 'offline'): void {
    const message = JSON.stringify({
      type: 'node_status',
      node_id: nodeId,
      zone_id: zoneId,
      status,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  function broadcastProbabilityUpdate(
    zoneId: string,
    probability: number,
    sources?: { csi: number | null; acoustic: number | null; gps: number | null },
  ): void {
    const message = JSON.stringify({
      type: 'probability_update',
      zone_id: zoneId,
      probability,
      ...(sources && { sources }),
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  // --- Control del servidor ---

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.listen(port, () => {
        console.log(`[server] Dashboard disponible en http://localhost:${port}`);
        resolve();
      });
      httpServer.on('error', reject);
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      // Cerrar conexiones WebSocket
      for (const client of wss.clients) {
        client.close();
      }

      httpServer.close(() => {
        resolve();
      });
    });
  }

  return {
    app,
    httpServer,
    wss,
    start,
    stop,
    broadcastCsiUpdate,
    broadcastZoneAdded,
    broadcastFieldReport,
    broadcastNodeStatus,
    broadcastProbabilityUpdate,
  };
}

// --- Consultas a la base de datos ---

/**
 * Obtiene todas las zonas con su última probabilidad y timestamp de actualización.
 * Las zonas sin datos en probability_scores retornan null.
 */
function getZonesWithProbability(db: Database.Database): ZoneWithProbability[] {
  const rows = db.prepare(`
    SELECT
      z.id,
      z.name,
      z.center_lat,
      z.center_lon,
      z.radius_m,
      z.created_at,
      ps.score AS last_probability,
      ps.computed_at AS last_update
    FROM zones z
    LEFT JOIN probability_scores ps ON z.id = ps.zone_id
    ORDER BY z.name ASC
  `).all() as ZoneWithProbability[];

  return rows;
}

/**
 * Obtiene todos los reportes de campo (ubicaciones sincronizadas desde apps móviles).
 * Retorna los 200 más recientes para renderizar en el mapa.
 */
function getFieldReports(db: Database.Database): FieldReportEntry[] {
  const rows = db.prepare(`
    SELECT id, lat, lon, note, captured_at
    FROM location_entries
    ORDER BY captured_at DESC
    LIMIT 200
  `).all() as FieldReportEntry[];

  return rows;
}

export default createDashboardServer;
