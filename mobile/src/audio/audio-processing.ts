/**
 * Funciones puras de procesamiento de audio para detección acústica.
 * Exportadas separadamente para facilitar pruebas unitarias y property-based tests.
 *
 * Requisitos: 1.1, 1.6, 1.7
 */

/**
 * Calcula el RMS (Root Mean Square) a partir de datos de dominio temporal.
 * Los datos provienen de getFloatTimeDomainData del AnalyserNode.
 *
 * @param timeDomainData - Array de muestras de audio en rango [-1, 1]
 * @returns Valor RMS (0.0 a 1.0)
 */
export function computeRms(timeDomainData: Float32Array): number {
  if (timeDomainData.length === 0) return 0;

  let sumOfSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const sample = timeDomainData[i];
    sumOfSquares += sample * sample;
  }

  return Math.sqrt(sumOfSquares / timeDomainData.length);
}

/**
 * Actualiza el piso de ruido usando suavizado exponencial.
 *
 * Formula: noiseFloor = alpha * currentRms + (1 - alpha) * previousNoiseFloor
 *
 * @param currentRms - Valor RMS actual
 * @param previousNoiseFloor - Piso de ruido previo
 * @param alpha - Factor de suavizado (por defecto 0.005)
 * @returns Nuevo piso de ruido
 */
export function updateNoiseFloor(
  currentRms: number,
  previousNoiseFloor: number,
  alpha: number = 0.005,
): number {
  return alpha * currentRms + (1 - alpha) * previousNoiseFloor;
}

/**
 * Clasifica si una muestra RMS es un pico basándose en el piso de ruido.
 *
 * Un pico se detecta cuando RMS excede max(3.5 × noiseFloor, 0.06)
 *
 * @param rms - Valor RMS actual
 * @param noiseFloor - Piso de ruido actual
 * @returns true si la muestra es un pico
 */
export function classifyPeak(rms: number, noiseFloor: number): boolean {
  const threshold = Math.max(3.5 * noiseFloor, 0.06);
  return rms > threshold;
}

/**
 * Valor inicial del piso de ruido según especificación.
 */
export const INITIAL_NOISE_FLOOR = 0.02;

/**
 * Factor alpha para suavizado exponencial del piso de ruido.
 */
export const NOISE_FLOOR_ALPHA = 0.005;

/**
 * Umbral mínimo absoluto para clasificación de picos.
 */
export const PEAK_ABSOLUTE_THRESHOLD = 0.06;

/**
 * Multiplicador del piso de ruido para umbral de pico.
 */
export const PEAK_NOISE_MULTIPLIER = 3.5;
