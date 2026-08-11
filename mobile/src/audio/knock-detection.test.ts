/**
 * Tests unitarios y property-based para detección de patrones de golpe.
 *
 * Feature: cali-rescue-system, Property 1: Knock pattern classification
 * Feature: cali-rescue-system, Property 2: Alert cooldown suppression
 *
 * Requisitos: 1.2, 1.3, 1.4, 1.5
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ALERT_COOLDOWN_MS,
  CENTROID_MAX_HZ,
  CENTROID_MIN_HZ,
  classifyKnockPattern,
  computeSpectralCentroid,
  filterPeaksInWindow,
  isValidCentroid,
  MAX_CV_RATIO,
  MAX_MEAN_INTERVAL_MS,
  MIN_MEAN_INTERVAL_MS,
  MIN_PEAKS,
  PATTERN_WINDOW_MS,
  shouldEmitAlert,
} from './knock-detection';

// --- Tests unitarios: Centroide espectral ---

describe('computeSpectralCentroid', () => {
  it('retorna 0 para array vacío', () => {
    const data = new Float32Array(0);
    expect(computeSpectralCentroid(data, 44100, 2048)).toBe(0);
  });

  it('retorna 0 si no hay energía (todo -Infinity dB)', () => {
    const data = new Float32Array(1024).fill(-Infinity);
    expect(computeSpectralCentroid(data, 44100, 2048)).toBe(0);
  });

  it('retorna la frecuencia del bin con energía concentrada', () => {
    // Simular energía concentrada en un solo bin, silencio total en el resto
    const sampleRate = 44100;
    const fftSize = 2048;
    const binWidth = sampleRate / fftSize;
    const data = new Float32Array(1024).fill(-Infinity); // Silencio absoluto
    const targetBin = 50; // ~1075 Hz
    data[targetBin] = 0; // Máxima energía en este bin

    const centroid = computeSpectralCentroid(data, sampleRate, fftSize);
    // Con solo un bin con energía, el centroide debe ser exactamente esa frecuencia
    const expectedFreq = targetBin * binWidth;
    expect(centroid).toBeCloseTo(expectedFreq, 5);
  });
});

describe('isValidCentroid', () => {
  it('acepta centroide dentro del rango 300–3500 Hz', () => {
    expect(isValidCentroid(300)).toBe(true);
    expect(isValidCentroid(1000)).toBe(true);
    expect(isValidCentroid(3500)).toBe(true);
  });

  it('rechaza centroide fuera del rango', () => {
    expect(isValidCentroid(299)).toBe(false);
    expect(isValidCentroid(3501)).toBe(false);
    expect(isValidCentroid(0)).toBe(false);
    expect(isValidCentroid(5000)).toBe(false);
  });
});

// --- Tests unitarios: Clasificación de patrón ---

describe('classifyKnockPattern', () => {
  it('rechaza menos de 3 picos', () => {
    expect(classifyKnockPattern([]).isPattern).toBe(false);
    expect(classifyKnockPattern([1000]).isPattern).toBe(false);
    expect(classifyKnockPattern([1000, 1500]).isPattern).toBe(false);
  });

  it('detecta patrón regular con 3 golpes', () => {
    // 3 golpes cada 500ms — regular
    const result = classifyKnockPattern([0, 500, 1000]);
    expect(result.isPattern).toBe(true);
    expect(result.peakCount).toBe(3);
    expect(result.meanInterval).toBe(500);
    expect(result.intervalStdDev).toBe(0);
  });

  it('detecta patrón regular con 5 golpes', () => {
    const result = classifyKnockPattern([0, 400, 800, 1200, 1600]);
    expect(result.isPattern).toBe(true);
    expect(result.peakCount).toBe(5);
    expect(result.meanInterval).toBe(400);
  });

  it('rechaza intervalos con media fuera de rango (muy rápido)', () => {
    // Intervalos de 100ms — demasiado rápido (< 200ms)
    const result = classifyKnockPattern([0, 100, 200, 300]);
    expect(result.isPattern).toBe(false);
  });

  it('rechaza intervalos con media fuera de rango (muy lento)', () => {
    // Intervalos de 3000ms — demasiado lento (> 2500ms)
    const result = classifyKnockPattern([0, 3000, 6000]);
    expect(result.isPattern).toBe(false);
  });

  it('rechaza intervalos con alta variabilidad', () => {
    // Intervalos: 200ms, 2000ms, 300ms — stdev muy alta
    const result = classifyKnockPattern([0, 200, 2200, 2500]);
    // Media: 833ms, stdev alta relativa
    expect(result.isPattern).toBe(false);
  });
});

// --- Tests unitarios: Cooldown de alertas ---

describe('shouldEmitAlert', () => {
  it('emite si no hay alerta previa', () => {
    expect(shouldEmitAlert(null, 5000)).toBe(true);
  });

  it('emite después de 4 segundos', () => {
    expect(shouldEmitAlert(1000, 5000)).toBe(true); // 4000ms exacto
    expect(shouldEmitAlert(1000, 6000)).toBe(true); // > 4000ms
  });

  it('suprime dentro de 4 segundos', () => {
    expect(shouldEmitAlert(1000, 4999)).toBe(false); // 3999ms
    expect(shouldEmitAlert(1000, 2000)).toBe(false); // 1000ms
  });
});

// --- Tests unitarios: Ventana deslizante ---

describe('filterPeaksInWindow', () => {
  it('retorna array vacío para entrada vacía', () => {
    expect(filterPeaksInWindow([], 10000)).toEqual([]);
  });

  it('mantiene picos dentro de la ventana de 6 segundos', () => {
    const now = 10000;
    const peaks = [4000, 4500, 5000, 8000, 9000, 10000];
    // windowStart = 10000 - 6000 = 4000
    const filtered = filterPeaksInWindow(peaks, now);
    expect(filtered).toEqual([4000, 4500, 5000, 8000, 9000, 10000]);
  });

  it('descarta picos fuera de la ventana', () => {
    const now = 10000;
    const peaks = [1000, 2000, 3999, 4000, 5000];
    // windowStart = 10000 - 6000 = 4000
    const filtered = filterPeaksInWindow(peaks, now);
    expect(filtered).toEqual([4000, 5000]);
  });
});

// --- Property-based tests ---

/**
 * **Validates: Requirements 1.3**
 *
 * Property 1: Knock pattern classification — sequence is a KnockPattern iff
 * (a) ≥3 peaks, (b) mean interval 200–2500ms, (c) stdev <55% of mean interval
 */
describe('Property 1: Clasificación de patrón de golpe', () => {
  it('secuencias con intervalos regulares dentro de rango son patrones válidos', () => {
    fc.assert(
      fc.property(
        // Generar secuencia de picos con intervalos regulares
        fc.integer({ min: MIN_PEAKS, max: 10 }),
        fc.integer({ min: MIN_MEAN_INTERVAL_MS, max: MAX_MEAN_INTERVAL_MS }),
        (peakCount, interval) => {
          // Crear timestamps con intervalo constante (stdev = 0)
          const timestamps = Array.from({ length: peakCount }, (_, i) => i * interval);
          const result = classifyKnockPattern(timestamps);

          // Debe ser patrón: ≥3 picos, media en rango, stdev = 0 < 55% media
          expect(result.isPattern).toBe(true);
          expect(result.peakCount).toBe(peakCount);
          expect(result.meanInterval).toBeCloseTo(interval, 5);
          expect(result.intervalStdDev).toBeCloseTo(0, 5);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('secuencias con <3 picos nunca son patrones', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100000 }), { minLength: 0, maxLength: 2 }),
        (timestamps) => {
          const sorted = [...timestamps].sort((a, b) => a - b);
          const result = classifyKnockPattern(sorted);
          expect(result.isPattern).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('secuencias con media fuera de rango no son patrones', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        fc.oneof(
          fc.integer({ min: 10, max: MIN_MEAN_INTERVAL_MS - 1 }), // Demasiado rápido
          fc.integer({ min: MAX_MEAN_INTERVAL_MS + 1, max: 5000 }), // Demasiado lento
        ),
        (peakCount, interval) => {
          const timestamps = Array.from({ length: peakCount }, (_, i) => i * interval);
          const result = classifyKnockPattern(timestamps);
          expect(result.isPattern).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('clasificación correcta para secuencias arbitrarias de timestamps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 60000 }), { minLength: 3, maxLength: 15 }),
        (timestamps) => {
          const sorted = [...timestamps].sort((a, b) => a - b);
          // Eliminar duplicados
          const unique = sorted.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
          if (unique.length < MIN_PEAKS) return; // No testeable con < 3 picos únicos

          const result = classifyKnockPattern(unique);

          // Calcular propiedades manualmente
          const intervals = [];
          for (let i = 1; i < unique.length; i++) {
            intervals.push(unique[i] - unique[i - 1]);
          }
          const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
          const variance =
            intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
          const stddev = Math.sqrt(variance);

          const expectedPattern =
            unique.length >= MIN_PEAKS &&
            mean >= MIN_MEAN_INTERVAL_MS &&
            mean <= MAX_MEAN_INTERVAL_MS &&
            stddev < MAX_CV_RATIO * mean;

          expect(result.isPattern).toBe(expectedPattern);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/**
 * **Validates: Requirements 1.4**
 *
 * Property 2: Alert cooldown suppression — emit alert for first detection,
 * suppress subsequent within 4 seconds
 */
describe('Property 2: Supresión de cooldown de alertas', () => {
  it('primera alerta siempre se emite', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000000 }), (timestamp) => {
        expect(shouldEmitAlert(null, timestamp)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('alertas dentro de 4s del último alert son suprimidas', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        fc.integer({ min: 0, max: ALERT_COOLDOWN_MS - 1 }),
        (lastAlert, delta) => {
          const current = lastAlert + delta;
          expect(shouldEmitAlert(lastAlert, current)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('alertas después de ≥4s del último alert se emiten', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        fc.integer({ min: ALERT_COOLDOWN_MS, max: 60000 }),
        (lastAlert, delta) => {
          const current = lastAlert + delta;
          expect(shouldEmitAlert(lastAlert, current)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('secuencia de detecciones: solo la primera y las que respetan cooldown se emiten', () => {
    fc.assert(
      fc.property(
        // Generar secuencia de timestamps de detección (ordenados crecientes)
        fc.array(fc.integer({ min: 100, max: 2000 }), { minLength: 2, maxLength: 20 }),
        (deltas) => {
          // Crear timestamps acumulados
          const timestamps: number[] = [0];
          for (const delta of deltas) {
            timestamps.push(timestamps[timestamps.length - 1] + delta);
          }

          // Simular emisión de alertas
          let lastEmitted: number | null = null;
          const emittedAlerts: number[] = [];

          for (const ts of timestamps) {
            if (shouldEmitAlert(lastEmitted, ts)) {
              emittedAlerts.push(ts);
              lastEmitted = ts;
            }
          }

          // Verificar: primera siempre se emite
          expect(emittedAlerts[0]).toBe(timestamps[0]);

          // Verificar: entre alertas emitidas consecutivas siempre hay ≥4s
          for (let i = 1; i < emittedAlerts.length; i++) {
            expect(emittedAlerts[i] - emittedAlerts[i - 1]).toBeGreaterThanOrEqual(
              ALERT_COOLDOWN_MS,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property: Centroide espectral ---

describe('Property: isValidCentroid filtra correctamente', () => {
  it('acepta solo frecuencias en rango [300, 3500] Hz', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10000, noNaN: true }), (freq) => {
        const expected = freq >= CENTROID_MIN_HZ && freq <= CENTROID_MAX_HZ;
        expect(isValidCentroid(freq)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

// --- Property: Ventana deslizante ---

describe('Property: filterPeaksInWindow mantiene solo picos dentro de 6s', () => {
  it('todos los picos retenidos están dentro de la ventana (≥ windowStart)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 30000 }), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 6000, max: 30000 }),
        (peaks, now) => {
          const sorted = [...peaks].sort((a, b) => a - b);
          const filtered = filterPeaksInWindow(sorted, now);

          const windowStart = now - PATTERN_WINDOW_MS;
          // Todos los picos retenidos deben tener timestamp >= windowStart
          for (const t of filtered) {
            expect(t).toBeGreaterThanOrEqual(windowStart);
          }
          // Todos los picos descartados deben tener timestamp < windowStart
          const discarded = sorted.filter((t) => !filtered.includes(t));
          for (const t of discarded) {
            expect(t).toBeLessThan(windowStart);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
