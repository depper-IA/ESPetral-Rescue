#!/usr/bin/env node
/**
 * ESPetral Rescue — Analizador de spike de fase CSI (Fase 0, gate de
 * validación csi-vitals-per-node).
 *
 * Consume capturas NDJSON de tres sesiones (A: sala vacía, B: metrónomo
 * 12 BPM, C: metrónomo 20 BPM) publicadas por el nodo en
 * cali/zone/{zone_id}/csi_phase_spike y calcula un veredicto GO/NO-GO
 * objetivo (sin juicio humano) según los criterios G1-G4 del diseño.
 *
 * Formato de captura esperado (NDJSON, una línea por mensaje MQTT
 * recibido, en el mismo formato que publica
 * firmware/main/csi_publisher.c::csi_publisher_publish_phase_spike()):
 *   {"zone_id":"...","node_id":"...","timestamp":"ISO8601","seq":123,
 *    "phase_raw":[8 floats],"phase_san":[8 floats],
 *    "fit_a":float,"fit_b":float}
 *
 * Uso:
 *   node analyze-phase-spike.mjs --empty captura-a.ndjson \
 *                                 --b12 captura-b.ndjson \
 *                                 --b20 captura-c.ndjson
 *
 * Salida: una línea de veredicto legible por máquina, por ejemplo:
 *   VERDICT=GO channels_passed=8/8 g1=8/8 g2=8/8 g3=8/8 g4=8/8
 * o
 *   VERDICT=NO-GO channels_passed=2/8 g1=2/8 g2=3/8 g3=8/8 g4=2/8
 *
 * Criterios (ver design.md, Fase 0 — Spike). El veredicto humano no
 * forma parte de esta decisión — es puramente el resultado de estas
 * cuatro condiciones, evaluadas por subportadora:
 *   G1 Precisión de frecuencia pico en B y C: |BPM_pico - BPM_verdad| <= 2 BPM
 *   G2 SNR en banda en B y C: 10*log10(P(f0+-0.02Hz) / P(0.1-0.5Hz excl. f0)) >= 6 dB
 *   G3 Especificidad: sesión A NO debe producir ningún pico con SNR >= 6 dB en 0.1-0.5Hz
 *   G4 Estabilidad: pico presente en >= 8 de 10 sub-ventanas de 30s (50% de solape)
 *
 * GO exige que las 4 condiciones se cumplan en las
 * PHASE_SPIKE_SUBCARRIER_COUNT subportadoras muestreadas por el spike.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Constantes del criterio de veredicto (ver design.md, Fase 0 — Spike)
// ---------------------------------------------------------------------------

/** Banda de respiración en Hz (0.1-0.5 Hz = 6-30 BPM). */
export const BREATHING_BAND_HZ = { min: 0.1, max: 0.5 };

/** Umbral de SNR en banda para considerar un pico válido (dB). */
export const SNR_THRESHOLD_DB = 6.0;

/** Tolerancia de precisión de frecuencia pico (BPM). */
export const PEAK_ACCURACY_TOLERANCE_BPM = 2.0;

/** Media banda alrededor del pico para el cálculo de SNR (Hz). */
export const SNR_PEAK_HALF_WIDTH_HZ = 0.02;

/** Número de subportadoras muestreadas por el spike de fase (Fase 0). */
export const PHASE_SPIKE_SUBCARRIER_COUNT = 8;

/** Índices de subportadora muestreados — deben coincidir con
 * PHASE_SPIKE_SUBCARRIER_INDICES en firmware/main/csi_publisher.c. */
export const PHASE_SPIKE_SUBCARRIER_INDICES = [6, 12, 18, 24, 32, 40, 48, 56];

/** G4 — estabilidad: 10 sub-ventanas de 30s con 50% de solape, >= 8 deben pasar. */
export const STABILITY_WINDOW_SECONDS = 30;
export const STABILITY_SUBWINDOW_COUNT = 10;
export const STABILITY_MIN_PASSING = 8;

// ---------------------------------------------------------------------------
// D1 — Saneador de fase (unwrap + ajuste lineal). Espejo exacto del
// algoritmo de firmware/main/csi_publisher.c::sanitize_phase(), para
// poder re-derivar y validar el saneador de forma independiente offline
// (ver comentario de diseño D1: "Raw + sanitized are both shipped so the
// sanitizer itself can be re-derived offline").
// ---------------------------------------------------------------------------

/**
 * Desenvolver (unwrap) una serie de fase a lo largo de su índice.
 * @param {number[]} phases fase envuelta en [-pi, pi]
 * @returns {number[]} fase desenvuelta
 */
export function unwrapPhase(phases) {
  if (phases.length === 0) return [];
  const unwrapped = [phases[0]];
  for (let k = 1; k < phases.length; k++) {
    let delta = phases[k] - phases[k - 1];
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    unwrapped.push(unwrapped[k - 1] + delta);
  }
  return unwrapped;
}

/**
 * Ajuste lineal por mínimos cuadrados y = a*k + b sobre índices 0..n-1.
 * @param {number[]} values
 * @returns {{ a: number, b: number }}
 */
export function linearFit(values) {
  const n = values.length;
  if (n === 0) return { a: 0, b: 0 };

  let sumK = 0;
  let sumY = 0;
  let sumKY = 0;
  let sumKK = 0;
  for (let k = 0; k < n; k++) {
    sumK += k;
    sumY += values[k];
    sumKY += k * values[k];
    sumKK += k * k;
  }

  const denom = n * sumKK - sumK * sumK;
  if (Math.abs(denom) < 1e-9) {
    return { a: 0, b: sumY / n };
  }

  const a = (n * sumKY - sumK * sumY) / denom;
  const b = (sumY - a * sumK) / n;
  return { a, b };
}

/**
 * Saneador D1 completo: unwrap + ajuste lineal + residuo.
 * @param {number[]} phases fase cruda envuelta, por índice de subportadora
 * @returns {{ unwrapped: number[], a: number, b: number, residual: number[] }}
 */
export function sanitizePhase(phases) {
  const unwrapped = unwrapPhase(phases);
  const { a, b } = linearFit(unwrapped);
  const residual = unwrapped.map((v, k) => v - (a * k + b));
  return { unwrapped, a, b, residual };
}

// ---------------------------------------------------------------------------
// D2 — Remuestreo a rejilla fija (zero-order hold sobre el último valor
// conocido en cada instante de la rejilla). Necesario porque los
// paquetes CSI llegan con jitter, no a una tasa exacta.
// ---------------------------------------------------------------------------

/**
 * Remuestrear una serie temporal irregular a una rejilla fija de rateHz,
 * usando zero-order hold (repite el último valor conocido).
 * @param {{t: number, v: number}[]} samples muestras (no necesariamente ordenadas), t en segundos
 * @param {number} rateHz frecuencia de la rejilla de salida
 * @param {number} durationSeconds duración total de la rejilla
 * @returns {{ values: number[], fill: number }} fill = fracción de la rejilla cubierta por muestras reales
 */
export function resampleToGrid(samples, rateHz, durationSeconds) {
  const gridSize = Math.max(1, Math.round(durationSeconds * rateHz));

  if (samples.length === 0) {
    return { values: new Array(gridSize).fill(0), fill: 0 };
  }

  const sorted = [...samples].sort((s1, s2) => s1.t - s2.t);
  const t0 = sorted[0].t;

  const values = new Array(gridSize);
  let sampleIdx = 0;
  let lastValue = sorted[0].v;
  let consumed = 0;

  for (let i = 0; i < gridSize; i++) {
    const gridT = t0 + i / rateHz;
    while (sampleIdx < sorted.length && sorted[sampleIdx].t <= gridT) {
      lastValue = sorted[sampleIdx].v;
      sampleIdx++;
      consumed++;
    }
    values[i] = lastValue;
  }

  const fill = Math.min(1, consumed / gridSize);
  return { values, fill };
}

// ---------------------------------------------------------------------------
// Welch PSD — promedio de periodogramas de segmentos solapados y
// ventaneados (Hann). Cada bin de frecuencia se calcula por sumatoria
// DFT directa, evaluada SOLO en las frecuencias de interés (banda de
// respiración) en lugar de un FFT de propósito general — para
// ventanas de unos pocos cientos de muestras esto es más simple y
// perfectamente viable en un script de análisis offline (no es código
// de firmware ni de tiempo real).
// ---------------------------------------------------------------------------

function hannWindow(n) {
  if (n <= 1) return new Array(Math.max(n, 0)).fill(1);
  const w = new Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

/**
 * Potencia (periodograma) de una señal en una frecuencia dada, vía DFT
 * directa (suma de correlaciones seno/coseno) normalizada por N^2.
 */
function dftPower(signal, fs, freqHz) {
  const n = signal.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const angle = (-2 * Math.PI * freqHz * i) / fs;
    re += signal[i] * Math.cos(angle);
    im += signal[i] * Math.sin(angle);
  }
  return (re * re + im * im) / (n * n);
}

/**
 * Densidad espectral de potencia por el método de Welch: promedia el
 * periodograma (ventaneado con Hann) de segmentos solapados.
 * @param {number[]} signal señal en el dominio temporal (rejilla uniforme)
 * @param {number} fs frecuencia de muestreo (Hz)
 * @param {number[]} freqs frecuencias objetivo (Hz) a evaluar
 * @param {{segmentSeconds?: number, overlap?: number}} [opts]
 * @returns {number[]} potencia por cada frecuencia en freqs
 */
export function welchPSD(signal, fs, freqs, opts = {}) {
  const segmentSeconds = opts.segmentSeconds ?? STABILITY_WINDOW_SECONDS;
  const overlap = opts.overlap ?? 0.5;
  const segLen = Math.min(signal.length, Math.max(1, Math.round(segmentSeconds * fs)));
  const step = Math.max(1, Math.round(segLen * (1 - overlap)));

  const segments = [];
  for (let start = 0; start + segLen <= signal.length; start += step) {
    segments.push(signal.slice(start, start + segLen));
  }
  if (segments.length === 0) {
    segments.push(signal);
  }

  const psdSum = new Array(freqs.length).fill(0);
  for (const seg of segments) {
    const window = hannWindow(seg.length);
    const windowed = seg.map((v, i) => v * window[i]);
    for (let i = 0; i < freqs.length; i++) {
      psdSum[i] += dftPower(windowed, fs, freqs[i]);
    }
  }
  return psdSum.map((sum) => sum / segments.length);
}

/**
 * Generar una grilla de frecuencias uniformemente espaciadas dentro de un rango (incl. maxHz).
 */
export function frequencyGrid(minHz, maxHz, stepHz) {
  const freqs = [];
  for (let f = minHz; f <= maxHz + 1e-9; f += stepHz) {
    freqs.push(Number(f.toFixed(6)));
  }
  return freqs;
}

/**
 * Encontrar el pico (frecuencia de máxima potencia) dentro de una banda.
 * @returns {{ freqHz: number, bpm: number, power: number } | null}
 */
export function findPeak(freqs, psd, band = BREATHING_BAND_HZ) {
  let best = null;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < band.min || freqs[i] > band.max) continue;
    if (best === null || psd[i] > best.power) {
      best = { freqHz: freqs[i], power: psd[i] };
    }
  }
  if (best === null) return null;
  return { freqHz: best.freqHz, bpm: best.freqHz * 60, power: best.power };
}

/**
 * Calcular el SNR en banda (dB) de un pico centrado en centerHz, contra
 * el resto de la banda de respiración (excluyendo el propio pico).
 * G2 / G3: 10*log10( P(f0 +/- halfWidthHz) / P(banda excl. f0) )
 */
export function computeSnrDb(
  freqs,
  psd,
  centerHz,
  band = BREATHING_BAND_HZ,
  halfWidthHz = SNR_PEAK_HALF_WIDTH_HZ
) {
  let signalSum = 0;
  let signalCount = 0;
  let noiseSum = 0;
  let noiseCount = 0;

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < band.min || f > band.max) continue;
    if (Math.abs(f - centerHz) <= halfWidthHz) {
      signalSum += psd[i];
      signalCount++;
    } else {
      noiseSum += psd[i];
      noiseCount++;
    }
  }

  if (signalCount === 0 || noiseCount === 0) return -Infinity;

  const signalPower = signalSum / signalCount;
  const noisePower = noiseSum / noiseCount;
  if (noisePower <= 0) return signalPower > 0 ? Infinity : -Infinity;

  return 10 * Math.log10(signalPower / noisePower);
}

/**
 * Analizar un canal (subportadora) completo: PSD de Welch en la banda de
 * respiración, pico dominante y su SNR en banda.
 * @param {number[]} signal señal saneada (phase_san) en rejilla uniforme
 * @param {number} fs frecuencia de la rejilla (Hz)
 * @returns {{ peak: {freqHz:number, bpm:number, power:number}|null, snrDb: number, freqs: number[], psd: number[] }}
 */
export function analyzeChannel(signal, fs, opts = {}) {
  const freqs = frequencyGrid(BREATHING_BAND_HZ.min, BREATHING_BAND_HZ.max, opts.freqStepHz ?? 0.005);
  const psd = welchPSD(signal, fs, freqs, opts);
  const peak = findPeak(freqs, psd);
  const snrDb = peak ? computeSnrDb(freqs, psd, peak.freqHz) : -Infinity;
  return { peak, snrDb, freqs, psd };
}

/**
 * G4 — Estabilidad: evalúa si un pico cercano a targetBpm (dentro de
 * PEAK_ACCURACY_TOLERANCE_BPM) con SNR >= SNR_THRESHOLD_DB aparece en al
 * menos STABILITY_MIN_PASSING de STABILITY_SUBWINDOW_COUNT sub-ventanas
 * solapadas al 50%, distribuidas uniformemente a lo largo de la captura.
 */
export function evaluateStability(signal, fs, targetBpm, opts = {}) {
  const windowSeconds = opts.windowSeconds ?? STABILITY_WINDOW_SECONDS;
  const subWindowCount = opts.subWindowCount ?? STABILITY_SUBWINDOW_COUNT;
  const windowLen = Math.min(signal.length, Math.round(windowSeconds * fs));
  const maxStart = Math.max(0, signal.length - windowLen);

  let passing = 0;
  let checked = 0;

  for (let w = 0; w < subWindowCount; w++) {
    const start = subWindowCount > 1 ? Math.round((maxStart * w) / (subWindowCount - 1)) : 0;
    const segment = signal.slice(start, start + windowLen);
    if (segment.length < windowLen * 0.5) continue; // segmento demasiado corto — no cuenta

    checked++;
    const { peak, snrDb } = analyzeChannel(segment, fs, opts);
    if (
      peak &&
      snrDb >= SNR_THRESHOLD_DB &&
      Math.abs(peak.bpm - targetBpm) <= PEAK_ACCURACY_TOLERANCE_BPM
    ) {
      passing++;
    }
  }

  return { passing, checked, stable: passing >= STABILITY_MIN_PASSING };
}

// ---------------------------------------------------------------------------
// Veredicto G1-G4 por subportadora, agregado a GO/NO-GO global
// ---------------------------------------------------------------------------

/**
 * Evaluar los 4 criterios G1-G4 para UNA subportadora, usando las tres
 * sesiones de captura (A: vacía, B: metrónomo truthBpmB, C: metrónomo truthBpmC).
 */
export function evaluateChannelCriteria({ signalA, signalB, signalC, fs, truthBpmB, truthBpmC }) {
  const analysisA = analyzeChannel(signalA, fs);
  const analysisB = analyzeChannel(signalB, fs);
  const analysisC = analyzeChannel(signalC, fs);

  const g1 =
    !!analysisB.peak &&
    !!analysisC.peak &&
    Math.abs(analysisB.peak.bpm - truthBpmB) <= PEAK_ACCURACY_TOLERANCE_BPM &&
    Math.abs(analysisC.peak.bpm - truthBpmC) <= PEAK_ACCURACY_TOLERANCE_BPM;

  const g2 = analysisB.snrDb >= SNR_THRESHOLD_DB && analysisC.snrDb >= SNR_THRESHOLD_DB;

  const g3 = !(analysisA.peak && analysisA.snrDb >= SNR_THRESHOLD_DB);

  const stabilityB = evaluateStability(signalB, fs, truthBpmB);
  const stabilityC = evaluateStability(signalC, fs, truthBpmC);
  const g4 = stabilityB.stable && stabilityC.stable;

  const pass = g1 && g2 && g3 && g4;

  return {
    pass,
    g1,
    g2,
    g3,
    g4,
    details: { analysisA, analysisB, analysisC, stabilityB, stabilityC },
  };
}

/**
 * Calcular el veredicto GO/NO-GO global. GO exige que las 4 condiciones
 * G1-G4 se cumplan en TODAS (>= PHASE_SPIKE_SUBCARRIER_COUNT) las
 * subportadoras muestreadas — ver design.md: "GO iff ALL four criteria
 * hold on >= 8 subcarriers".
 * @returns {{ go: boolean, passedCount: number, channelCount: number, results: object[] }}
 */
export function computeVerdict({ channelsA, channelsB, channelsC, fs, truthBpmB, truthBpmC }) {
  const channelCount = channelsB.length;
  const results = [];

  for (let ch = 0; ch < channelCount; ch++) {
    results.push(
      evaluateChannelCriteria({
        signalA: channelsA[ch],
        signalB: channelsB[ch],
        signalC: channelsC[ch],
        fs,
        truthBpmB,
        truthBpmC,
      })
    );
  }

  const passedCount = results.filter((r) => r.pass).length;
  const requiredCount = Math.min(channelCount, PHASE_SPIKE_SUBCARRIER_COUNT);
  const go = channelCount > 0 && passedCount >= requiredCount;

  return { go, passedCount, channelCount, results };
}

// ---------------------------------------------------------------------------
// Consistencia del payload de captura
// ---------------------------------------------------------------------------

/**
 * Verificar de forma independiente que phase_san == phase_raw - (fit_a*k + fit_b)
 * para los índices de subportadora muestreados, como control de
 * consistencia del saneador de firmware. No re-deriva el ajuste LSQ (que
 * se hizo sobre las 64 subportadoras completas en firmware, no
 * disponibles offline) — solo valida que el residuo publicado sea
 * coherente con fit_a/fit_b.
 * @param {{phase_raw:number[], phase_san:number[], fit_a:number, fit_b:number}} record
 * @param {number[]} indices índices de subportadora correspondientes a cada posición del arreglo
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function crossValidateSanitizer(record, indices, tolerance = 1e-3) {
  return indices.every((idx, i) => {
    const expected = record.phase_raw[i] - (record.fit_a * idx + record.fit_b);
    return Math.abs(expected - record.phase_san[i]) <= tolerance;
  });
}

// ---------------------------------------------------------------------------
// Lectura de capturas NDJSON
// ---------------------------------------------------------------------------

/**
 * Parsear un archivo de captura NDJSON del spike de fase.
 * @param {string} path
 * @returns {object[]} registros parseados, uno por línea no vacía
 */
export function parseCaptureFile(path) {
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Construir las señales por canal (una por subportadora muestreada),
 * remuestreadas a una rejilla uniforme de fs Hz, a partir de registros
 * de captura NDJSON ya parseados.
 * @param {object[]} records
 * @param {number} [fs]
 * @returns {{ channels: number[][], fs: number, fillMin: number }}
 */
export function buildChannelSignals(records, fs = 10) {
  if (records.length === 0) {
    return { channels: [], fs, fillMin: 0 };
  }

  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const t0 = Date.parse(sorted[0].timestamp) / 1000;
  const tLast = Date.parse(sorted[sorted.length - 1].timestamp) / 1000;
  const durationSeconds = Math.max(1, tLast - t0);
  const channelCount = sorted[0].phase_san.length;

  const channels = [];
  let fillMin = 1;
  for (let ch = 0; ch < channelCount; ch++) {
    const samples = sorted.map((r) => ({ t: Date.parse(r.timestamp) / 1000 - t0, v: r.phase_san[ch] }));
    const { values, fill } = resampleToGrid(samples, fs, durationSeconds);
    channels.push(values);
    fillMin = Math.min(fillMin, fill);
  }

  return { channels, fs, fillMin };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Correr el análisis completo de las 3 sesiones de captura y devolver el veredicto.
 */
export function runAnalysis({ emptyPath, b12Path, b20Path, truthB = 12, truthC = 20, fs = 10 }) {
  const recordsA = parseCaptureFile(emptyPath);
  const recordsB = parseCaptureFile(b12Path);
  const recordsC = parseCaptureFile(b20Path);

  const { channels: channelsA } = buildChannelSignals(recordsA, fs);
  const { channels: channelsB } = buildChannelSignals(recordsB, fs);
  const { channels: channelsC } = buildChannelSignals(recordsC, fs);

  return computeVerdict({ channelsA, channelsB, channelsC, fs, truthBpmB: truthB, truthBpmC: truthC });
}

/**
 * Formatear el veredicto como una línea de texto legible por máquina.
 */
export function formatVerdictLine(verdict) {
  const counts = verdict.results.reduce(
    (acc, r) => {
      acc.g1 += r.g1 ? 1 : 0;
      acc.g2 += r.g2 ? 1 : 0;
      acc.g3 += r.g3 ? 1 : 0;
      acc.g4 += r.g4 ? 1 : 0;
      return acc;
    },
    { g1: 0, g2: 0, g3: 0, g4: 0 }
  );
  const n = verdict.channelCount;
  return (
    `VERDICT=${verdict.go ? 'GO' : 'NO-GO'} ` +
    `channels_passed=${verdict.passedCount}/${n} ` +
    `g1=${counts.g1}/${n} g2=${counts.g2}/${n} g3=${counts.g3}/${n} g4=${counts.g4}/${n}`
  );
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.empty || !args.b12 || !args.b20) {
    console.error(
      'Uso: node analyze-phase-spike.mjs --empty <captura-a.ndjson> --b12 <captura-b.ndjson> --b20 <captura-c.ndjson> ' +
        '[--truth-b <bpm>] [--truth-c <bpm>] [--fs <hz>]'
    );
    process.exit(1);
  }

  const verdict = runAnalysis({
    emptyPath: args.empty,
    b12Path: args.b12,
    b20Path: args.b20,
    truthB: args['truth-b'] ? Number(args['truth-b']) : 12,
    truthC: args['truth-c'] ? Number(args['truth-c']) : 20,
    fs: args.fs ? Number(args.fs) : 10,
  });

  console.log(formatVerdictLine(verdict));
  process.exit(verdict.go ? 0 : 1);
}
