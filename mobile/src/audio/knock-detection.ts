/**
 * Funciones puras para detección de patrones de golpe (knock patterns).
 * Incluye: centroide espectral, clasificación de patrones, y cooldown de alertas.
 *
 * Exportadas para facilitar property-based testing.
 *
 * Requisitos: 1.2, 1.3, 1.4, 1.5
 */

// --- Constantes ---

/** Ventana de tiempo para detección de patrones (ms) */
export const PATTERN_WINDOW_MS = 6000;

/** Mínimo de picos para considerar un patrón */
export const MIN_PEAKS = 3;

/** Intervalo medio mínimo entre picos (ms) */
export const MIN_MEAN_INTERVAL_MS = 200;

/** Intervalo medio máximo entre picos (ms) */
export const MAX_MEAN_INTERVAL_MS = 2500;

/** Máximo coeficiente de variación (stdev / mean) permitido */
export const MAX_CV_RATIO = 0.55;

/** Cooldown entre alertas consecutivas (ms) */
export const ALERT_COOLDOWN_MS = 4000;

/** Frecuencia mínima del centroide espectral para aceptar un pico (Hz) */
export const CENTROID_MIN_HZ = 300;

/** Frecuencia máxima del centroide espectral para aceptar un pico (Hz) */
export const CENTROID_MAX_HZ = 3500;

// --- Centroide Espectral ---

/**
 * Calcula el centroide espectral a partir de datos de frecuencia (magnitudes FFT).
 *
 * El centroide espectral es el "centro de masa" del espectro:
 *   centroid = Σ(f_i * m_i) / Σ(m_i)
 *
 * donde f_i es la frecuencia del bin i y m_i es la magnitud en ese bin.
 *
 * @param frequencyData - Array de magnitudes FFT (típicamente de getFloatFrequencyData, en dB)
 * @param sampleRate - Tasa de muestreo del contexto de audio (e.g. 44100)
 * @param fftSize - Tamaño de la FFT (e.g. 2048)
 * @returns Centroide espectral en Hz, o 0 si no hay energía
 */
export function computeSpectralCentroid(
  frequencyData: Float32Array,
  sampleRate: number,
  fftSize: number,
): number {
  const binCount = frequencyData.length;
  if (binCount === 0) return 0;

  const binWidth = sampleRate / fftSize;

  let weightedSum = 0;
  let magnitudeSum = 0;

  for (let i = 0; i < binCount; i++) {
    // getFloatFrequencyData devuelve valores en dB, convertir a magnitud lineal
    const magnitudeDb = frequencyData[i];
    // Los valores de dB van desde -Infinity (silencio) hasta 0 (máximo).
    // Convertimos a escala lineal para el promedio ponderado.
    const magnitude = Math.pow(10, magnitudeDb / 20);
    const frequency = i * binWidth;

    weightedSum += frequency * magnitude;
    magnitudeSum += magnitude;
  }

  if (magnitudeSum === 0) return 0;

  return weightedSum / magnitudeSum;
}

/**
 * Determina si un pico pasa el filtro de centroide espectral.
 *
 * @param centroid - Centroide espectral calculado (Hz)
 * @returns true si el centroide está entre 300–3500 Hz
 */
export function isValidCentroid(centroid: number): boolean {
  return centroid >= CENTROID_MIN_HZ && centroid <= CENTROID_MAX_HZ;
}

// --- Clasificación de Patrón de Golpe ---

/**
 * Resultado de la clasificación de un patrón de golpe.
 */
export interface KnockPatternResult {
  /** Indica si se detectó un patrón válido */
  isPattern: boolean;
  /** Número de picos en la ventana */
  peakCount: number;
  /** Intervalo medio entre picos (ms), 0 si < 2 picos */
  meanInterval: number;
  /** Desviación estándar de intervalos (ms), 0 si < 2 picos */
  intervalStdDev: number;
}

/**
 * Clasifica una secuencia de timestamps de picos como patrón de golpe o no.
 *
 * Criterios (todos deben cumplirse):
 * 1. ≥3 picos en la ventana
 * 2. Intervalo medio entre 200–2500 ms
 * 3. Stdev de intervalos < 55% del intervalo medio
 *
 * @param peakTimestamps - Array de timestamps (ms) de picos filtrados, ordenados cronológicamente
 * @returns Resultado de la clasificación
 */
export function classifyKnockPattern(peakTimestamps: number[]): KnockPatternResult {
  const peakCount = peakTimestamps.length;

  if (peakCount < MIN_PEAKS) {
    return {
      isPattern: false,
      peakCount,
      meanInterval: 0,
      intervalStdDev: 0,
    };
  }

  // Calcular intervalos entre picos consecutivos
  const intervals: number[] = [];
  for (let i = 1; i < peakCount; i++) {
    intervals.push(peakTimestamps[i] - peakTimestamps[i - 1]);
  }

  // Calcular media
  const meanInterval = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;

  // Calcular desviación estándar (población)
  const variance =
    intervals.reduce((sum, v) => sum + (v - meanInterval) ** 2, 0) / intervals.length;
  const intervalStdDev = Math.sqrt(variance);

  // Criterios de clasificación
  const isPattern =
    meanInterval >= MIN_MEAN_INTERVAL_MS &&
    meanInterval <= MAX_MEAN_INTERVAL_MS &&
    intervalStdDev < MAX_CV_RATIO * meanInterval;

  return {
    isPattern,
    peakCount,
    meanInterval,
    intervalStdDev,
  };
}

// --- Cooldown de Alertas ---

/**
 * Determina si se debe emitir una alerta basándose en el cooldown.
 *
 * Regla: emitir alerta solo si han pasado ≥4 segundos desde la última alerta emitida,
 * o si no hay alerta previa.
 *
 * @param lastAlertTimestamp - Timestamp de la última alerta emitida (ms), o null si no hay previa
 * @param currentTimestamp - Timestamp actual (ms)
 * @returns true si se puede emitir una nueva alerta
 */
export function shouldEmitAlert(
  lastAlertTimestamp: number | null,
  currentTimestamp: number,
): boolean {
  if (lastAlertTimestamp === null) return true;
  return currentTimestamp - lastAlertTimestamp >= ALERT_COOLDOWN_MS;
}

// --- Confianza del patrón detectado ---

/**
 * Calcula un valor de confianza [0,1] para un patrón de golpe detectado,
 * basado en qué tan por debajo del umbral máximo de variación (MAX_CV_RATIO)
 * cae la desviación estándar de los intervalos respecto a la media.
 * Menor variación relativa → mayor confianza.
 *
 * Usado al enviar el reporte acústico al backend (Requisito 11.5).
 *
 * @param meanInterval - Intervalo medio entre picos (ms)
 * @param intervalStdDev - Desviación estándar de los intervalos (ms)
 * @returns Confianza en [0,1], o 0 si meanInterval es 0 o negativo
 */
export function computeKnockConfidence(meanInterval: number, intervalStdDev: number): number {
  if (meanInterval <= 0) return 0;

  const cvRatio = intervalStdDev / (MAX_CV_RATIO * meanInterval);
  const confidence = 1 - cvRatio;

  return Math.max(0, Math.min(1, confidence));
}

// --- Ventana deslizante de picos ---

/**
 * Filtra una lista de timestamps para mantener solo los que están
 * dentro de la ventana de 6 segundos desde el timestamp más reciente.
 *
 * @param peakTimestamps - Array de timestamps de picos (ms), ordenados cronológicamente
 * @param now - Timestamp actual (ms)
 * @returns Array filtrado con solo los picos dentro de la ventana
 */
export function filterPeaksInWindow(peakTimestamps: number[], now: number): number[] {
  const windowStart = now - PATTERN_WINDOW_MS;
  return peakTimestamps.filter((t) => t >= windowStart);
}
