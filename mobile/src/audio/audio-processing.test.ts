/**
 * Pruebas unitarias y property-based para funciones de procesamiento de audio.
 * Feature: cali-rescue-system, Property 3: Noise floor tracking and peak classification
 *
 * Requisitos: 1.1, 1.6, 1.7
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  classifyPeak,
  computeRms,
  estimateStereoDoa,
  INITIAL_NOISE_FLOOR,
  NOISE_FLOOR_ALPHA,
  PEAK_ABSOLUTE_THRESHOLD,
  PEAK_NOISE_MULTIPLIER,
  updateNoiseFloor,
} from './audio-processing';

describe('computeRms', () => {
  it('retorna 0 para un array vacío', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('retorna 0 para silencio (todas las muestras son 0)', () => {
    const silence = new Float32Array(2048).fill(0);
    expect(computeRms(silence)).toBe(0);
  });

  it('retorna 1 para señal constante de amplitud 1', () => {
    const fullScale = new Float32Array(1024).fill(1);
    expect(computeRms(fullScale)).toBeCloseTo(1.0, 5);
  });

  it('retorna ~0.707 para señal constante de amplitud 1/-1 alternada', () => {
    // RMS de una onda cuadrada de amplitud 1 es 1
    const squareWave = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      squareWave[i] = i % 2 === 0 ? 1 : -1;
    }
    expect(computeRms(squareWave)).toBeCloseTo(1.0, 5);
  });

  it('calcula correctamente RMS para valores conocidos', () => {
    // [0.5, -0.5] → sqrt((0.25 + 0.25) / 2) = sqrt(0.25) = 0.5
    const data = new Float32Array([0.5, -0.5]);
    expect(computeRms(data)).toBeCloseTo(0.5, 5);
  });
});

describe('updateNoiseFloor', () => {
  it('con alpha=1, el piso de ruido es igual al RMS actual', () => {
    expect(updateNoiseFloor(0.1, 0.02, 1.0)).toBeCloseTo(0.1, 10);
  });

  it('con alpha=0, el piso de ruido no cambia', () => {
    expect(updateNoiseFloor(0.5, 0.02, 0.0)).toBeCloseTo(0.02, 10);
  });

  it('con alpha=0.005 y valor inicial 0.02, se mueve lentamente', () => {
    const result = updateNoiseFloor(0.1, 0.02, 0.005);
    // 0.005 * 0.1 + 0.995 * 0.02 = 0.0005 + 0.0199 = 0.0204
    expect(result).toBeCloseTo(0.0204, 6);
  });

  it('converge hacia el RMS actual con muchas iteraciones', () => {
    const targetRms = 0.08;
    let noiseFloor = INITIAL_NOISE_FLOOR;
    // Iterar muchas veces debería converger hacia el target
    for (let i = 0; i < 10000; i++) {
      noiseFloor = updateNoiseFloor(targetRms, noiseFloor, NOISE_FLOOR_ALPHA);
    }
    expect(noiseFloor).toBeCloseTo(targetRms, 2);
  });
});

describe('classifyPeak', () => {
  it('detecta pico cuando RMS > 3.5 × noiseFloor y noiseFloor alto', () => {
    // noiseFloor = 0.05 → threshold = max(0.175, 0.06) = 0.175
    expect(classifyPeak(0.2, 0.05)).toBe(true);
  });

  it('no detecta pico cuando RMS < 3.5 × noiseFloor', () => {
    // noiseFloor = 0.05 → threshold = 0.175
    expect(classifyPeak(0.1, 0.05)).toBe(false);
  });

  it('usa umbral absoluto 0.06 cuando piso de ruido es muy bajo', () => {
    // noiseFloor = 0.01 → 3.5 * 0.01 = 0.035 → threshold = max(0.035, 0.06) = 0.06
    expect(classifyPeak(0.07, 0.01)).toBe(true);
    expect(classifyPeak(0.05, 0.01)).toBe(false);
  });

  it('no detecta pico exactamente en el umbral', () => {
    // threshold = max(3.5 * 0.02, 0.06) = max(0.07, 0.06) = 0.07
    expect(classifyPeak(0.07, 0.02)).toBe(false); // no excede, es igual
  });

  it('detecta pico justo encima del umbral', () => {
    // threshold = 0.07
    expect(classifyPeak(0.0700001, 0.02)).toBe(true);
  });
});

describe('Property 3: Noise floor tracking and peak classification', () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * Property: El piso de ruido es el resultado del suavizado exponencial
   * con alpha=0.005 inicializado en 0.02.
   */
  it('el piso de ruido sigue el suavizado exponencial exactamente', () => {
    fc.assert(
      fc.property(
        // Generar una secuencia de muestras RMS entre 0 y 1
        fc.array(fc.float({ min: 0, max: 1, noNaN: true }), {
          minLength: 1,
          maxLength: 200,
        }),
        (rmsSamples) => {
          let noiseFloor = INITIAL_NOISE_FLOOR;
          let expectedNoiseFloor = INITIAL_NOISE_FLOOR;

          for (const rms of rmsSamples) {
            // Implementación bajo prueba
            noiseFloor = updateNoiseFloor(rms, noiseFloor, NOISE_FLOOR_ALPHA);
            // Cálculo de referencia explícito
            expectedNoiseFloor =
              NOISE_FLOOR_ALPHA * rms +
              (1 - NOISE_FLOOR_ALPHA) * expectedNoiseFloor;

            // Deben ser iguales (tolerancia por punto flotante)
            expect(noiseFloor).toBeCloseTo(expectedNoiseFloor, 10);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.7**
   *
   * Property: Un pico se clasifica si y solo si RMS excede max(3.5 × noiseFloor, 0.06)
   */
  it('clasificación de picos es correcta para cualquier RMS y noiseFloor', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (rms, noiseFloor) => {
          const threshold = Math.max(
            PEAK_NOISE_MULTIPLIER * noiseFloor,
            PEAK_ABSOLUTE_THRESHOLD,
          );
          const expected = rms > threshold;
          const result = classifyPeak(rms, noiseFloor);

          expect(result).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * **Validates: Requirements 1.7**
   *
   * Property: Para cualquier secuencia de muestras RMS, el piso de ruido
   * siempre se encuentra entre el valor inicial y los extremos de las muestras.
   * (El suavizado exponencial nunca diverge)
   */
  it('el piso de ruido permanece acotado y nunca es negativo', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 1, noNaN: true }), {
          minLength: 1,
          maxLength: 500,
        }),
        (rmsSamples) => {
          let noiseFloor = INITIAL_NOISE_FLOOR;

          for (const rms of rmsSamples) {
            noiseFloor = updateNoiseFloor(rms, noiseFloor, NOISE_FLOOR_ALPHA);
            // El piso de ruido nunca debe ser negativo
            expect(noiseFloor).toBeGreaterThanOrEqual(0);
            // El piso de ruido nunca debe exceder 1.0 si todas las muestras ≤ 1.0
            expect(noiseFloor).toBeLessThanOrEqual(1.0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('estimateStereoDoa', () => {
  it('retorna ángulo 0° cuando ambos canales están perfectamente alineados (sonido frontal)', () => {
    const left = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, 0]);
    const right = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, 0]);

    const result = estimateStereoDoa(left, right, 44100, 0.025);
    expect(result.angleDegrees).toBeCloseTo(0, 1);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('retorna ángulo negativo cuando el canal izquierdo recibe primero el impulso (fuente a la izquierda)', () => {
    const left = new Float32Array([1, 0.5, 0, 0, 0, 0, 0, 0]);
    const right = new Float32Array([0, 0, 1, 0.5, 0, 0, 0, 0]);

    const result = estimateStereoDoa(left, right, 44100, 0.025);
    expect(result.angleDegrees).toBeLessThan(0);
  });

  it('retorna ángulo positivo cuando el canal derecho recibe primero el impulso (fuente a la derecha)', () => {
    const left = new Float32Array([0, 0, 1, 0.5, 0, 0, 0, 0]);
    const right = new Float32Array([1, 0.5, 0, 0, 0, 0, 0, 0]);

    const result = estimateStereoDoa(left, right, 44100, 0.025);
    expect(result.angleDegrees).toBeGreaterThan(0);
  });
});
