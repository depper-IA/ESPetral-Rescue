/**
 * ESPetral Rescue — Tests del analizador de spike de fase CSI (Fase 0,
 * gate de validación csi-vitals-per-node).
 *
 * Todas las aserciones usan datos SINTÉTICOS (nunca capturas reales de
 * hardware — esas no existen todavía, dependen de sesiones humanas con
 * un ESP32 físico). El objetivo de este archivo es validar que el
 * saneador D1 (unwrap + ajuste lineal) y el pipeline de PSD de Welch
 * son matemáticamente correctos, para que cuando SÍ existan capturas
 * reales el veredicto GO/NO-GO que produzcan sea confiable.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  unwrapPhase,
  linearFit,
  sanitizePhase,
  resampleToGrid,
  welchPSD,
  frequencyGrid,
  findPeak,
  computeSnrDb,
  analyzeChannel,
  evaluateStability,
  computeVerdict,
  crossValidateSanitizer,
  parseCaptureFile,
  buildChannelSignals,
  BREATHING_BAND_HZ,
  SNR_THRESHOLD_DB,
  PEAK_ACCURACY_TOLERANCE_BPM,
} from './analyze-phase-spike.mjs';

/** PRNG determinista (mulberry32) — ruido reproducible entre corridas. */
function makePrng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Genera ruido gaussiano aproximado (Box-Muller) a partir del PRNG. */
function gaussianNoise(rng, n, stdDev) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    out[i] = stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

/** Genera una señal senoidal + ruido, en radianes, a fs Hz durante durationSeconds. */
function sineWithNoise({ freqHz, amplitude, fs, durationSeconds, noiseStdDev, seed }) {
  const n = Math.round(durationSeconds * fs);
  const rng = makePrng(seed);
  const noise = gaussianNoise(rng, n, noiseStdDev);
  const signal = new Array(n);
  for (let i = 0; i < n; i++) {
    signal[i] = amplitude * Math.sin(2 * Math.PI * freqHz * (i / fs)) + noise[i];
  }
  return signal;
}

function noiseOnly({ fs, durationSeconds, noiseStdDev, seed }) {
  const n = Math.round(durationSeconds * fs);
  return gaussianNoise(makePrng(seed), n, noiseStdDev);
}

describe('D1 — unwrapPhase', () => {
  it('desenvuelve una rampa lineal envuelta y recupera los valores originales', () => {
    const n = 64;
    const original = Array.from({ length: n }, (_, k) => 0.3 * k + 1.0);
    const wrapped = original.map((phi) => Math.atan2(Math.sin(phi), Math.cos(phi)));

    const unwrapped = unwrapPhase(wrapped);

    for (let k = 0; k < n; k++) {
      expect(unwrapped[k]).toBeCloseTo(original[k], 3);
    }
  });

  it('serie vacía devuelve arreglo vacío', () => {
    expect(unwrapPhase([])).toEqual([]);
  });

  it('serie de un elemento se devuelve sin cambios', () => {
    expect(unwrapPhase([1.5])).toEqual([1.5]);
  });
});

describe('D1 — linearFit', () => {
  it('recupera pendiente y ordenada de datos perfectamente lineales', () => {
    const values = Array.from({ length: 64 }, (_, k) => 0.3 * k + 1.0);
    const { a, b } = linearFit(values);
    expect(a).toBeCloseTo(0.3, 5);
    expect(b).toBeCloseTo(1.0, 5);
  });

  it('arreglo vacío no lanza y devuelve ceros', () => {
    expect(linearFit([])).toEqual({ a: 0, b: 0 });
  });
});

describe('D1 — sanitizePhase (saneador completo)', () => {
  it('el residuo de una fase envuelta puramente lineal es ~0 en todas las subportadoras', () => {
    const n = 64;
    const original = Array.from({ length: n }, (_, k) => 0.3 * k + 1.0);
    const wrapped = original.map((phi) => Math.atan2(Math.sin(phi), Math.cos(phi)));

    const { residual, a, b } = sanitizePhase(wrapped);

    expect(a).toBeCloseTo(0.3, 3);
    expect(b).toBeCloseTo(1.0, 3);
    for (const r of residual) {
      expect(Math.abs(r)).toBeLessThan(1e-3);
    }
  });

  it('una perturbación senoidal inyectada sobre la recta sobrevive en el residuo', () => {
    const n = 64;
    const perturbation = (k) => 0.05 * Math.sin((2 * Math.PI * k) / 16);
    const original = Array.from({ length: n }, (_, k) => 0.3 * k + 1.0 + perturbation(k));
    const wrapped = original.map((phi) => Math.atan2(Math.sin(phi), Math.cos(phi)));

    const { residual } = sanitizePhase(wrapped);

    // El ajuste LSQ puede absorber una fracción mínima de una perturbación
    // periódica de banda ancha (no es perfectamente ortogonal a la recta
    // en una ventana finita) — se tolera un error pequeño por punto en
    // lugar de exigir coincidencia exacta.
    for (let k = 0; k < n; k++) {
      expect(residual[k]).toBeCloseTo(perturbation(k), 1);
    }
  });
});

describe('D2 — resampleToGrid', () => {
  it('produce el tamaño de rejilla esperado y fill=1 con muestras densas y regulares', () => {
    const fs = 10;
    const durationSeconds = 10;
    const samples = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, v: i }));

    const { values, fill } = resampleToGrid(samples, fs, durationSeconds);

    expect(values).toHaveLength(100);
    expect(fill).toBeCloseTo(1, 1);
  });

  it('fill decrece cuando la mitad de las muestras faltan (pérdida de paquetes)', () => {
    const fs = 10;
    const durationSeconds = 10;
    const dense = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, v: i }));
    const sparse = dense.filter((_, i) => i % 2 === 0);

    const denseResult = resampleToGrid(dense, fs, durationSeconds);
    const sparseResult = resampleToGrid(sparse, fs, durationSeconds);

    expect(sparseResult.fill).toBeLessThan(denseResult.fill);
  });

  it('serie vacía no lanza y devuelve rejilla en cero', () => {
    const { values, fill } = resampleToGrid([], 10, 5);
    expect(values).toHaveLength(50);
    expect(fill).toBe(0);
  });
});

describe('Welch PSD — detección de pico sintético', () => {
  it('detecta el pico en 12 BPM (0.2 Hz) con alto SNR sobre una senoidal + ruido', () => {
    const fs = 10;
    const durationSeconds = 180;
    const signal = sineWithNoise({
      freqHz: 12 / 60,
      amplitude: 0.3,
      fs,
      durationSeconds,
      noiseStdDev: 0.02,
      seed: 1,
    });

    const { peak, snrDb } = analyzeChannel(signal, fs);

    expect(peak).not.toBeNull();
    expect(Math.abs(peak.bpm - 12)).toBeLessThanOrEqual(PEAK_ACCURACY_TOLERANCE_BPM);
    expect(snrDb).toBeGreaterThanOrEqual(SNR_THRESHOLD_DB);
  });

  it('detecta el pico en 20 BPM (0.3333 Hz) con alto SNR sobre una senoidal + ruido', () => {
    const fs = 10;
    const durationSeconds = 180;
    const signal = sineWithNoise({
      freqHz: 20 / 60,
      amplitude: 0.3,
      fs,
      durationSeconds,
      noiseStdDev: 0.02,
      seed: 2,
    });

    const { peak, snrDb } = analyzeChannel(signal, fs);

    expect(peak).not.toBeNull();
    expect(Math.abs(peak.bpm - 20)).toBeLessThanOrEqual(PEAK_ACCURACY_TOLERANCE_BPM);
    expect(snrDb).toBeGreaterThanOrEqual(SNR_THRESHOLD_DB);
  });

  it('G3 — sala vacía (solo ruido) no produce ningún pico con SNR >= 6 dB en la banda de respiración', () => {
    const fs = 10;
    const durationSeconds = 180;
    const signal = noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 3 });

    const freqs = frequencyGrid(BREATHING_BAND_HZ.min, BREATHING_BAND_HZ.max, 0.005);
    const psd = welchPSD(signal, fs, freqs);
    const peak = findPeak(freqs, psd);
    const snrDb = peak ? computeSnrDb(freqs, psd, peak.freqHz) : -Infinity;

    expect(snrDb).toBeLessThan(SNR_THRESHOLD_DB);
  });
});

describe('G4 — evaluateStability', () => {
  it('una senoidal estable durante toda la captura pasa en >= 8 de 10 sub-ventanas', () => {
    const fs = 10;
    const durationSeconds = 180;
    const signal = sineWithNoise({
      freqHz: 12 / 60,
      amplitude: 0.3,
      fs,
      durationSeconds,
      noiseStdDev: 0.02,
      seed: 4,
    });

    const { passing, checked, stable } = evaluateStability(signal, fs, 12);

    expect(checked).toBe(10);
    expect(passing).toBeGreaterThanOrEqual(8);
    expect(stable).toBe(true);
  });

  it('ruido puro no es estable (falla en la mayoría de las sub-ventanas)', () => {
    const fs = 10;
    const durationSeconds = 180;
    const signal = noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 5 });

    const { stable } = evaluateStability(signal, fs, 12);

    expect(stable).toBe(false);
  });
});

describe('computeVerdict — GO/NO-GO agregado por canal', () => {
  it('escenario GO sintético: ruido en A, senoidales limpias en B y C en todos los canales', () => {
    const fs = 10;
    const durationSeconds = 180;
    const channelCount = 8;

    const channelsA = Array.from({ length: channelCount }, (_, ch) =>
      noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 100 + ch })
    );
    const channelsB = Array.from({ length: channelCount }, (_, ch) =>
      sineWithNoise({ freqHz: 12 / 60, amplitude: 0.3, fs, durationSeconds, noiseStdDev: 0.02, seed: 200 + ch })
    );
    const channelsC = Array.from({ length: channelCount }, (_, ch) =>
      sineWithNoise({ freqHz: 20 / 60, amplitude: 0.3, fs, durationSeconds, noiseStdDev: 0.02, seed: 300 + ch })
    );

    const verdict = computeVerdict({ channelsA, channelsB, channelsC, fs, truthBpmB: 12, truthBpmC: 20 });

    expect(verdict.go).toBe(true);
    expect(verdict.passedCount).toBe(channelCount);
  });

  it('escenario NO-GO sintético: ruido puro en las tres sesiones (sin señal de respiración)', () => {
    const fs = 10;
    const durationSeconds = 180;
    const channelCount = 8;

    const channelsA = Array.from({ length: channelCount }, (_, ch) =>
      noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 400 + ch })
    );
    const channelsB = Array.from({ length: channelCount }, (_, ch) =>
      noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 500 + ch })
    );
    const channelsC = Array.from({ length: channelCount }, (_, ch) =>
      noiseOnly({ fs, durationSeconds, noiseStdDev: 0.05, seed: 600 + ch })
    );

    const verdict = computeVerdict({ channelsA, channelsB, channelsC, fs, truthBpmB: 12, truthBpmC: 20 });

    expect(verdict.go).toBe(false);
    expect(verdict.passedCount).toBeLessThan(channelCount);
  });
});

describe('crossValidateSanitizer — consistencia phase_san vs phase_raw/fit_a/fit_b', () => {
  const indices = [6, 12, 18, 24, 32, 40, 48, 56];

  it('acepta un registro consistente', () => {
    const fitA = 0.1;
    const fitB = 0.5;
    const phaseRaw = indices.map((idx) => fitA * idx + fitB + 0.01 * idx);
    const phaseSan = indices.map((idx, i) => phaseRaw[i] - (fitA * idx + fitB));

    const record = { phase_raw: phaseRaw, phase_san: phaseSan, fit_a: fitA, fit_b: fitB };

    expect(crossValidateSanitizer(record, indices)).toBe(true);
  });

  it('rechaza un registro con phase_san alterado', () => {
    const fitA = 0.1;
    const fitB = 0.5;
    const phaseRaw = indices.map((idx) => fitA * idx + fitB + 0.01 * idx);
    const phaseSan = indices.map((idx, i) => phaseRaw[i] - (fitA * idx + fitB) + 5.0); // corrupto

    const record = { phase_raw: phaseRaw, phase_san: phaseSan, fit_a: fitA, fit_b: fitB };

    expect(crossValidateSanitizer(record, indices)).toBe(false);
  });
});

describe('parseCaptureFile / buildChannelSignals — formato NDJSON de captura', () => {
  it('parsea un archivo NDJSON y construye señales por canal remuestreadas', () => {
    const tmpPath = join(tmpdir(), `phase-spike-test-${Date.now()}.ndjson`);
    const lines = [];
    for (let seq = 0; seq < 20; seq++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq * 100)).toISOString();
      lines.push(
        JSON.stringify({
          zone_id: 'z1',
          node_id: 'n1',
          timestamp: ts,
          seq,
          phase_raw: new Array(8).fill(0).map((_, i) => i + seq * 0.01),
          phase_san: new Array(8).fill(0).map((_, i) => Math.sin(seq * 0.1 + i)),
          fit_a: 0.01,
          fit_b: 0.0,
        })
      );
    }
    writeFileSync(tmpPath, lines.join('\n'));

    try {
      const records = parseCaptureFile(tmpPath);
      expect(records).toHaveLength(20);

      const { channels, fs } = buildChannelSignals(records, 10);
      expect(channels).toHaveLength(8);
      expect(fs).toBe(10);
      expect(channels[0].length).toBeGreaterThan(0);
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
