/**
 * ESPetral Rescue — Motor de puntuación compuesta de probabilidad
 *
 * Calcula un Probability_Indicator por zona combinando tres fuentes:
 * - CSI (Wi-Fi Channel State Information): peso base 50%
 * - Reportes acústicos (knock patterns): peso base 35%
 * - Proximidad GPS (dispositivos cercanos): peso base 15%
 *
 * Implementa redistribución proporcional de pesos cuando hay menos de 3 fuentes
 * activas, exclusión de fuentes sin datos en los últimos 10 minutos, y emisión
 * de alertas prioritarias cuando el puntaje excede 70.
 *
 * Requisitos: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import type Database from 'better-sqlite3';
import type { MqttBrokerInstance } from './mqtt-broker.js';
import type { ProbabilityUpdate, PriorityAlert } from './types.js';

// --- Constantes de configuración ---

/** Pesos base para cada fuente de detección */
export const BASE_WEIGHTS = {
  csi: 50,
  acoustic: 35,
  gps: 15,
} as const;

/** Umbral de antigüedad máxima para considerar una fuente activa (10 minutos en ms) */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

/** Umbral de puntaje para emitir alerta prioritaria */
export const PRIORITY_ALERT_THRESHOLD = 70;

/** Radio máximo en metros para considerar un dispositivo GPS como "cercano" a una zona */
export const GPS_PROXIMITY_RADIUS_M = 50;

/** Ventana temporal para considerar entradas GPS relevantes (30 minutos en ms) */
export const GPS_RECENCY_WINDOW_MS = 30 * 60 * 1000;

// --- Tipos internos ---

/** Datos de una fuente individual para el cálculo compuesto */
export interface SourceData {
  /** Valor normalizado de la fuente (0.0 – 1.0) */
  value: number;
  /** Timestamp del último dato recibido */
  lastReport: Date;
}

/** Resultado intermedio del cálculo de pesos redistribuidos */
export interface RedistributedWeights {
  csi?: number;
  acoustic?: number;
  gps?: number;
}

/** Resultado del cálculo de probabilidad compuesta */
export interface CompositeResult {
  /** Puntaje final como entero [0, 100] */
  score: number;
  /** Contribución de cada fuente (null si la fuente fue excluida) */
  sources: {
    csi: number | null;
    acoustic: number | null;
    gps: number | null;
  };
}

// --- Funciones puras de cálculo (exportadas para testing) ---

/**
 * Determina si una fuente está activa (no es "stale") según su último reporte.
 * Una fuente se excluye si han pasado más de 10 minutos desde su último dato.
 */
export function isSourceActive(lastReport: Date, now: Date): boolean {
  const elapsed = now.getTime() - lastReport.getTime();
  return elapsed <= STALENESS_THRESHOLD_MS;
}

/**
 * Redistribuye los pesos proporcionalmente entre las fuentes disponibles.
 *
 * Cuando hay menos de 3 fuentes activas, los pesos de las fuentes disponibles
 * se escalan proporcionalmente para que sumen 100%.
 *
 * Ejemplo: CSI + acoustic → CSI=50/(50+35)≈58.8%, acoustic=35/(50+35)≈41.2%
 */
export function redistributeWeights(
  availableSources: Array<'csi' | 'acoustic' | 'gps'>
): RedistributedWeights {
  if (availableSources.length === 0) return {};

  const totalBaseWeight = availableSources.reduce(
    (sum, source) => sum + BASE_WEIGHTS[source],
    0
  );

  const weights: RedistributedWeights = {};
  for (const source of availableSources) {
    weights[source] = BASE_WEIGHTS[source] / totalBaseWeight;
  }

  return weights;
}

/**
 * Calcula el puntaje compuesto de probabilidad a partir de las fuentes disponibles.
 *
 * - Excluye fuentes sin datos en los últimos 10 minutos
 * - Redistribuye pesos proporcionalmente entre fuentes activas
 * - Retorna un entero en [0, 100]
 *
 * @param sources - Mapa de datos por fuente (puede tener 0 a 3 fuentes)
 * @param now - Momento actual para evaluar staleness
 * @returns Resultado compuesto o null si no hay fuentes activas
 */
export function computeCompositeScore(
  sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>>,
  now: Date
): CompositeResult | null {
  // Filtrar fuentes activas (no stale)
  const activeSources: Array<'csi' | 'acoustic' | 'gps'> = [];

  for (const key of ['csi', 'acoustic', 'gps'] as const) {
    const source = sources[key];
    if (source && isSourceActive(source.lastReport, now)) {
      activeSources.push(key);
    }
  }

  // Sin fuentes activas → no se puede calcular
  if (activeSources.length === 0) return null;

  // Redistribuir pesos entre fuentes activas
  const weights = redistributeWeights(activeSources);

  // Calcular suma ponderada
  let weightedSum = 0;
  for (const key of activeSources) {
    const source = sources[key]!;
    const weight = weights[key]!;
    weightedSum += source.value * weight;
  }

  // Convertir a entero [0, 100]
  const score = Math.round(weightedSum * 100);
  // Clamp por seguridad numérica
  const clampedScore = Math.max(0, Math.min(100, score));

  // Construir contribuciones por fuente
  const result: CompositeResult = {
    score: clampedScore,
    sources: {
      csi: null,
      acoustic: null,
      gps: null,
    },
  };

  for (const key of activeSources) {
    const source = sources[key]!;
    const weight = weights[key]!;
    result.sources[key] = source.value * weight * 100;
  }

  return result;
}

/**
 * Determina si se debe emitir una alerta prioritaria.
 * Se emite si y solo si el puntaje EXCEDE 70 (es decir, score > 70).
 */
export function shouldEmitPriorityAlert(score: number): boolean {
  return score > PRIORITY_ALERT_THRESHOLD;
}

// --- Clase principal del motor de puntuación ---

export interface ScoringEngineOptions {
  /** Instancia de la base de datos SQLite */
  db: Database.Database;
  /** Instancia del broker MQTT para publicar resultados */
  broker: MqttBrokerInstance;
}

/**
 * Motor de puntuación compuesta para el sistema ESPetral Rescue.
 *
 * Consulta la base de datos para obtener los últimos datos por zona,
 * calcula el puntaje compuesto, y publica actualizaciones y alertas
 * a través del broker MQTT.
 */
export class ScoringEngine {
  private db: Database.Database;
  private broker: MqttBrokerInstance;

  constructor(options: ScoringEngineOptions) {
    this.db = options.db;
    this.broker = options.broker;
  }

  /**
   * Calcula y publica el puntaje de probabilidad para una zona específica.
   * Invocable tanto bajo demanda (al recibir nuevos datos) como periódicamente.
   *
   * @param zoneId - Identificador de la zona a evaluar
   * @returns El resultado compuesto, o null si no hay fuentes activas
   */
  computeAndPublish(zoneId: string): CompositeResult | null {
    const now = new Date();
    const sources = this.gatherSourceData(zoneId, now);
    const result = computeCompositeScore(sources, now);

    if (result === null) return null;

    // Persistir puntaje en base de datos
    this.persistScore(zoneId, result);

    // Publicar actualización de probabilidad
    this.publishProbabilityUpdate(zoneId, result);

    // Emitir alerta prioritaria si corresponde
    if (shouldEmitPriorityAlert(result.score)) {
      this.publishPriorityAlert(zoneId, result);
    }

    return result;
  }

  /**
   * Recopila los datos más recientes de cada fuente para una zona dada.
   * Consulta la base de datos para CSI, reportes acústicos y entradas GPS.
   */
  private gatherSourceData(
    zoneId: string,
    now: Date
  ): Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {};

    // --- CSI: último motion_probability para la zona ---
    const csiRow = this.db
      .prepare(
        `SELECT motion_probability, received_at
         FROM csi_readings
         WHERE zone_id = ?
         ORDER BY received_at DESC
         LIMIT 1`
      )
      .get(zoneId) as { motion_probability: number; received_at: string } | undefined;

    if (csiRow) {
      sources.csi = {
        value: csiRow.motion_probability,
        lastReport: new Date(csiRow.received_at.replace(' ', 'T') + 'Z'),
      };
    }

    // --- Acoustic: último reporte con confidence para la zona ---
    const acousticRow = this.db
      .prepare(
        `SELECT confidence, received_at
         FROM acoustic_reports
         WHERE zone_id = ?
         ORDER BY received_at DESC
         LIMIT 1`
      )
      .get(zoneId) as { confidence: number; received_at: string } | undefined;

    if (acousticRow) {
      sources.acoustic = {
        value: acousticRow.confidence,
        lastReport: new Date(acousticRow.received_at.replace(' ', 'T') + 'Z'),
      };
    }

    // --- GPS: proporción de dispositivos cercanos con actividad reciente ---
    const gpsData = this.computeGpsProximityScore(zoneId, now);
    if (gpsData) {
      sources.gps = gpsData;
    }

    return sources;
  }

  /**
   * Calcula el puntaje GPS basado en la cantidad de dispositivos cercanos
   * que han reportado ubicación dentro del radio de la zona en los últimos 30 min.
   *
   * Valor normalizado: min(cantidad_dispositivos / 3, 1.0)
   * (3 dispositivos cercanos = máxima señal GPS)
   */
  private computeGpsProximityScore(zoneId: string, now: Date): SourceData | null {
    // Obtener centro y radio de la zona
    const zone = this.db
      .prepare(`SELECT center_lat, center_lon, radius_m FROM zones WHERE id = ?`)
      .get(zoneId) as { center_lat: number; center_lon: number; radius_m: number } | undefined;

    if (!zone) return null;

    const recencyCutoff = new Date(now.getTime() - GPS_RECENCY_WINDOW_MS)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    // Buscar entradas de ubicación recientes dentro del radio de la zona
    // Usamos una aproximación simple: filtrar por cuadrado delimitante
    // y luego calcular distancia Haversine simplificada
    const radiusDeg = zone.radius_m / 111_320; // Aproximación: 1° ≈ 111.32 km

    const rows = this.db
      .prepare(
        `SELECT lat, lon, received_at
         FROM location_entries
         WHERE received_at >= ?
           AND lat BETWEEN ? AND ?
           AND lon BETWEEN ? AND ?`
      )
      .all(
        recencyCutoff,
        zone.center_lat - radiusDeg,
        zone.center_lat + radiusDeg,
        zone.center_lon - radiusDeg,
        zone.center_lon + radiusDeg
      ) as Array<{ lat: number; lon: number; received_at: string }>;

    if (rows.length === 0) return null;

    // Filtrar por distancia real (Haversine simplificada para distancias cortas)
    const nearbyEntries = rows.filter((row) => {
      const dist = approximateDistanceMeters(
        zone.center_lat,
        zone.center_lon,
        row.lat,
        row.lon
      );
      return dist <= GPS_PROXIMITY_RADIUS_M;
    });

    if (nearbyEntries.length === 0) return null;

    // Encontrar el reporte más reciente para determinar staleness
    let latestReport = new Date(0);
    for (const entry of nearbyEntries) {
      const entryDate = new Date(entry.received_at.replace(' ', 'T') + 'Z');
      if (entryDate > latestReport) {
        latestReport = entryDate;
      }
    }

    // Valor normalizado: más dispositivos cercanos = mayor señal
    // 3 dispositivos = valor máximo (1.0)
    const value = Math.min(nearbyEntries.length / 3, 1.0);

    return { value, lastReport: latestReport };
  }

  /**
   * Persiste el puntaje calculado en la tabla probability_scores.
   * Usa UPSERT para actualizar si ya existe un registro para la zona.
   */
  private persistScore(zoneId: string, result: CompositeResult): void {
    this.db
      .prepare(
        `INSERT INTO probability_scores (zone_id, score, csi_contribution, acoustic_contribution, gps_contribution, computed_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(zone_id) DO UPDATE SET
           score = excluded.score,
           csi_contribution = excluded.csi_contribution,
           acoustic_contribution = excluded.acoustic_contribution,
           gps_contribution = excluded.gps_contribution,
           computed_at = excluded.computed_at`
      )
      .run(
        zoneId,
        result.score,
        result.sources.csi,
        result.sources.acoustic,
        result.sources.gps
      );
  }

  /**
   * Publica la actualización de probabilidad en el topic MQTT correspondiente.
   */
  private publishProbabilityUpdate(zoneId: string, result: CompositeResult): void {
    const update: ProbabilityUpdate = {
      zone_id: zoneId,
      probability: result.score,
      sources: result.sources,
      timestamp: new Date().toISOString(),
    };

    const topic = `cali/zone/${zoneId}/probability`;
    const payload = JSON.stringify(update);

    this.broker.aedes.publish(
      {
        topic,
        payload: Buffer.from(payload),
        qos: 1,
        retain: true,
        cmd: 'publish',
        dup: false,
      },
      () => {
        // Publicación completada
      }
    );
  }

  /**
   * Emite una alerta prioritaria cuando el puntaje excede el umbral de 70.
   */
  private publishPriorityAlert(zoneId: string, result: CompositeResult): void {
    const contributingFactors: string[] = [];
    if (result.sources.csi !== null) contributingFactors.push('csi');
    if (result.sources.acoustic !== null) contributingFactors.push('acoustic');
    if (result.sources.gps !== null) contributingFactors.push('gps');

    const alert: PriorityAlert = {
      zone_id: zoneId,
      probability: result.score,
      triggered_at: new Date().toISOString(),
      contributing_factors: contributingFactors,
    };

    const topic = `cali/zone/${zoneId}/priority`;
    const payload = JSON.stringify(alert);

    this.broker.aedes.publish(
      {
        topic,
        payload: Buffer.from(payload),
        qos: 1,
        retain: false,
        cmd: 'publish',
        dup: false,
      },
      () => {
        // Alerta publicada
      }
    );
  }
}

// --- Utilidades geográficas ---

/**
 * Calcula la distancia aproximada en metros entre dos puntos geográficos.
 * Usa la fórmula equirectangular (suficiente para distancias cortas <1km).
 */
export function approximateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6_371_000; // Radio de la Tierra en metros
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const avgLat = ((lat1 + lat2) / 2 * Math.PI) / 180;

  const x = dLon * Math.cos(avgLat);
  const y = dLat;

  return Math.sqrt(x * x + y * y) * R;
}

export default ScoringEngine;
