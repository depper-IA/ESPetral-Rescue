/**
 * Tests de regresión del detector de respiración, con jitter de muestreo
 * realista (los frames llegan por red, no a intervalo exacto).
 *
 * REGRESIÓN CUBIERTA: una versión previa estimaba el piso de ruido como la
 * mediana de TODO el espectro fuera de la banda. Con muestreo irregular, el
 * remuestreo por interpolación lineal atenúa las frecuencias altas, que son
 * la mayoría de esos bins; el piso quedaba artificialmente bajo y la banda
 * de respiración (frecuencia baja) sobresalía por simple inclinación
 * espectral. Eso producía FALSOS POSITIVOS con ruido puro — el peor error
 * posible en una herramienta de rescate. El piso de ruido pasó a estimarse
 * localmente alrededor del pico. El caso de ruido puro de abajo falla si esa
 * corrección se revierte.
 */
import { describe, it, expect } from 'vitest';
import { analyzeBreathing } from './breathing-detector';

/** PRNG determinista para que el test sea reproducible. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Genera frames con jitter de muestreo (±25% del intervalo nominal),
 * imitando la llegada irregular real por WiFi/MQTT.
 */
function makeFrames(opts: {
  breathHz: number | null;
  seconds: number;
  nominalHz: number;
  noise: number;
  amplitude: number;
  seed: number;
}) {
  const rng = makeRng(opts.seed);
  const frames: { amplitudes: number[]; timestampMs: number }[] = [];
  let t = 0;
  const nominalDt = 1000 / opts.nominalHz;
  while (t < opts.seconds * 1000) {
    const amps: number[] = [];
    for (let sc = 0; sc < 64; sc++) {
      let v = 20 + (rng() - 0.5) * opts.noise;
      // Solo algunas subportadoras llevan la modulación respiratoria,
      // como ocurre en CSI real.
      if (opts.breathHz !== null && sc >= 20 && sc <= 30) {
        v += opts.amplitude * Math.sin(2 * Math.PI * opts.breathHz * (t / 1000));
      }
      amps.push(v);
    }
    frames.push({ amplitudes: amps, timestampMs: t });
    t += nominalDt * (0.75 + rng() * 0.5); // jitter ±25%
  }
  return frames;
}

describe('validación independiente — detector de respiración', () => {
  it('detecta respiración adulta normal de 18 rpm (0.30 Hz) con jitter', () => {
    const frames = makeFrames({
      breathHz: 0.3, seconds: 90, nominalHz: 5, noise: 2, amplitude: 1.5, seed: 7,
    });
    const r = analyzeBreathing(frames);
    expect(r.status).toBe('detected');
    expect(r.bpm).not.toBeNull();
    expect(Math.abs((r.bpm as number) - 18)).toBeLessThanOrEqual(2);
  });

  it('detecta respiración lenta de 13 rpm (0.217 Hz), borde inferior de la banda', () => {
    const frames = makeFrames({
      breathHz: 0.217, seconds: 90, nominalHz: 5, noise: 2, amplitude: 1.5, seed: 11,
    });
    const r = analyzeBreathing(frames);
    expect(r.status).toBe('detected');
    expect(Math.abs((r.bpm as number) - 13)).toBeLessThanOrEqual(2.5);
  });

  it('NO reporta detección con ruido puro y jitter (sin falso positivo)', () => {
    for (const seed of [3, 21, 42, 99, 123]) {
      const frames = makeFrames({
        breathHz: null, seconds: 90, nominalHz: 5, noise: 4, amplitude: 0, seed,
      });
      const r = analyzeBreathing(frames);
      expect(r.status, `semilla ${seed} produjo falso positivo`).toBe('not_detected');
    }
  });

  it('NO confunde una vibración de maquinaria a 1.2 Hz con respiración', () => {
    const frames = makeFrames({
      breathHz: 1.2, seconds: 90, nominalHz: 5, noise: 2, amplitude: 3, seed: 5,
    });
    const r = analyzeBreathing(frames);
    expect(r.status).toBe('not_detected');
  });

  it('exige ventana mínima: 20s de datos no alcanzan', () => {
    const frames = makeFrames({
      breathHz: 0.3, seconds: 20, nominalHz: 5, noise: 2, amplitude: 1.5, seed: 9,
    });
    const r = analyzeBreathing(frames);
    expect(r.status).toBe('insufficient_data');
  });
});
