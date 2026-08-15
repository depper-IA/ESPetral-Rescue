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
| * Mapea un valor RMS lineal a un porcentaje logarítmico (0.0 a 1.0) usando la escala dBFS.
| * Rango mapeado: -60 dBFS (silencio ~0%) a 0 dBFS (máxima amplitud ~100%).
| *
| * @param rms - Valor RMS lineal (0.0 a 1.0)
| * @returns Porcentaje de nivel de audio (0.0 a 1.0)
| */
export function computeRmsPercentage(rms: number): number {
  if (rms <= 0.0001) return 0;
  const db = 20 * Math.log10(rms);
  const pct = (db + 60) / 60;
  return Math.min(1.0, Math.max(0.0, pct));
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

/**
 * Estima la diferencia de tiempo de llegada (TDOA) y el ángulo de dirección de arribo (DoA en grados)
 * entre los dos canales de un micrófono estéreo (ej. Boya BY-PM700 en modo estéreo).
 *
 * Canal L (izquierdo) y Canal R (derecho).
 *
 * @param leftChannel - Muestras de audio del canal izquierdo (Float32Array)
 * @param rightChannel - Muestras de audio del canal derecho (Float32Array)
 * @param sampleRate - Tasa de muestreo (por defecto 44100 Hz)
 * @param micDistanceMeters - Distancia aproximada entre cápsulas en metros (por defecto 0.025m para condensador estéreo)
 * @returns Objeto con tdoaSeconds, angleDegrees (-90° a +90°), y nivel de confianza
 */
export function estimateStereoDoa(
  leftChannel: Float32Array,
  rightChannel: Float32Array,
  sampleRate: number = 44100,
  micDistanceMeters: number = 0.025,
): { tdoaSeconds: number; angleDegrees: number; confidence: number } {
  if (leftChannel.length === 0 || rightChannel.length === 0) {
    return { tdoaSeconds: 0, angleDegrees: 0, confidence: 0 };
  }

  const length = Math.min(leftChannel.length, rightChannel.length);
  const speedOfSound = 343; // m/s
  const maxDelaySeconds = micDistanceMeters / speedOfSound;
  const maxLagSamples = Math.ceil(maxDelaySeconds * sampleRate);

  let bestLag = 0;
  let maxCrossCorr = -Infinity;
  let totalPowerLeft = 0;
  let totalPowerRight = 0;

  for (let i = 0; i < length; i++) {
    totalPowerLeft += leftChannel[i] * leftChannel[i];
    totalPowerRight += rightChannel[i] * rightChannel[i];
  }

  const norm = Math.sqrt(totalPowerLeft * totalPowerRight);
  if (norm < 1e-6) {
    return { tdoaSeconds: 0, angleDegrees: 0, confidence: 0 };
  }

  // Buscar el desfase óptimo en [-maxLagSamples, +maxLagSamples]
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const j = i + lag;
      if (j >= 0 && j < length) {
        sum += leftChannel[i] * rightChannel[j];
      }
    }
    if (sum > maxCrossCorr) {
      maxCrossCorr = sum;
      bestLag = lag;
    }
  }

  const tdoaSeconds = -bestLag / sampleRate;
  let sinAngle = (tdoaSeconds * speedOfSound) / micDistanceMeters;
  if (sinAngle > 1.0) sinAngle = 1.0;
  if (sinAngle < -1.0) sinAngle = -1.0;

  const angleDegrees = Math.asin(sinAngle) * (180 / Math.PI);
  const confidence = Math.min(1.0, Math.max(0, maxCrossCorr / norm));

  return { tdoaSeconds, angleDegrees, confidence };
}
