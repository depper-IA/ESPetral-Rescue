/**
 * Tests del detector de patrón respiratorio (analyzeBreathing).
 *
 * Se valida con señales sintéticas: la discriminación "persona viva vs.
 * ruido ambiental" es por PERIODICIDAD en la banda 0.2-0.5 Hz (12-30
 * resp/min), no por magnitud. Todos los generadores usan un PRNG
 * determinístico (mulberry32) para que las corridas sean reproducibles.
 */

import { describe, it, expect } from 'vitest';
import { analyzeBreathing, type BreathingFrameInput } from './breathing-detector';

const SUBCARRIER_COUNT = 64;

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Genera frames sintéticos con el mismo valor replicado en las 64 subportadoras. */
function makeFrames(params: {
  durationSeconds: number;
  sampleRateHz?: number;
  signal: (tSeconds: number) => number;
}): BreathingFrameInput[] {
  const { durationSeconds, sampleRateHz = 5, signal } = params;
  const dtMs = 1000 / sampleRateHz;
  const n = Math.round(durationSeconds * sampleRateHz);
  const frames: BreathingFrameInput[] = [];
  for (let i = 0; i < n; i++) {
    const tSeconds = i / sampleRateHz;
    const value = signal(tSeconds);
    frames.push({
      amplitudes: new Array(SUBCARRIER_COUNT).fill(value),
      timestampMs: i * dtMs,
    });
  }
  return frames;
}

describe('analyzeBreathing — datos insuficientes', () => {
  it('reporta insufficient_data con menos de ~30s de datos', () => {
    const frames = makeFrames({
      durationSeconds: 10,
      signal: (t) => 50 + Math.sin(2 * Math.PI * 0.25 * t),
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('insufficient_data');
    expect(result.bpm).toBeNull();
    expect(result.windowSeconds).toBeLessThan(30);
  });

  it('reporta insufficient_data con 0 o 1 frame', () => {
    expect(analyzeBreathing([]).status).toBe('insufficient_data');
    expect(analyzeBreathing([{ amplitudes: [1, 2, 3], timestampMs: 0 }]).status).toBe('insufficient_data');
  });
});

describe('analyzeBreathing — señal periódica en banda de respiración', () => {
  it('detecta un seno puro a 0.25 Hz (15 resp/min) con ruido leve', () => {
    const rand = mulberry32(42);
    const frames = makeFrames({
      durationSeconds: 90,
      signal: (t) => 50 + 3 * Math.sin(2 * Math.PI * 0.25 * t) + (rand() - 0.5) * 0.5,
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('detected');
    expect(result.bpm).not.toBeNull();
    expect(result.bpm as number).toBeGreaterThan(13);
    expect(result.bpm as number).toBeLessThan(17);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('detecta un seno puro a 0.4 Hz (24 resp/min) con ruido leve', () => {
    const rand = mulberry32(7);
    const frames = makeFrames({
      durationSeconds: 90,
      signal: (t) => 50 + 3 * Math.sin(2 * Math.PI * 0.4 * t) + (rand() - 0.5) * 0.5,
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('detected');
    expect(result.bpm).not.toBeNull();
    expect(result.bpm as number).toBeGreaterThan(22);
    expect(result.bpm as number).toBeLessThan(26);
  });
});

describe('analyzeBreathing — rechazo de falsos positivos', () => {
  it('reporta not_detected con ruido blanco puro sin periodicidad', () => {
    const rand = mulberry32(123);
    const frames = makeFrames({
      durationSeconds: 90,
      signal: () => 50 + (rand() - 0.5) * 10,
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('not_detected');
    expect(result.bpm).toBeNull();
  });

  it('reporta not_detected con deriva lineal fuerte sin componente periódica (prueba el detrend)', () => {
    const rand = mulberry32(9);
    const frames = makeFrames({
      durationSeconds: 90,
      signal: (t) => 50 + 2 * t + (rand() - 0.5) * 0.2,
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('not_detected');
    expect(result.bpm).toBeNull();
  });

  it('reporta not_detected con una señal periódica fuera de banda (1.5 Hz, ej. ventilador)', () => {
    const rand = mulberry32(55);
    const frames = makeFrames({
      durationSeconds: 90,
      signal: (t) => 50 + 5 * Math.sin(2 * Math.PI * 1.5 * t) + (rand() - 0.5) * 0.5,
    });
    const result = analyzeBreathing(frames);
    expect(result.status).toBe('not_detected');
    expect(result.bpm).toBeNull();
  });
});
