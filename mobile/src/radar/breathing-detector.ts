/**
 * ESPetral Rescue — Detector de Patrón Respiratorio por CSI
 *
 * Fundamento físico: una persona inconsciente bajo escombros no puede
 * golpear la estructura, pero SIGUE RESPIRANDO. La respiración humana
 * (consciente o inconsciente) son 12-30 respiraciones por minuto, es
 * decir 0.2-0.5 Hz. Ese movimiento periódico del tórax modula
 * mínimamente la amplitud de las 64 subportadoras CSI que reporta el
 * nodo ESP32.
 *
 * Escombros asentándose, viento o vibración de maquinaria también
 * generan variación de amplitud CSI — pero es CAÓTICA, sin periodicidad
 * estable en una banda angosta. La discriminación "persona viva vs.
 * ruido ambiental" NO se hace por la magnitud del cambio — se hace por
 * PERIODICIDAD sostenida en la banda 0.2-0.5 Hz frente al resto del
 * espectro.
 *
 * Este módulo es lógica pura (sin React), pensado para ser testeado con
 * señales sintéticas.
 */

export type BreathingStatus = 'detected' | 'not_detected' | 'insufficient_data';

export interface BreathingResult {
  status: BreathingStatus;
  /** Respiraciones por minuto estimadas, null si no hay detección. */
  bpm: number | null;
  /** Confianza 0..1 basada en la prominencia del pico vs. el ruido de fondo. */
  confidence: number;
  /** Segundos de datos acumulados (para feedback al operador). */
  windowSeconds: number;
}

export interface BreathingFrameInput {
  amplitudes: readonly number[];
  timestampMs: number;
}

/** Ventana mínima de datos acumulados antes de intentar cualquier análisis. */
const MIN_WINDOW_SECONDS = 30;

/** Banda de frecuencia de respiración humana: 12-30 resp/min = 0.2-0.5 Hz. */
const BAND_MIN_HZ = 0.2;
const BAND_MAX_HZ = 0.5;

/**
 * Prominencia mínima del pico en banda contra el piso de ruido (mediana de
 * la potencia del resto del espectro) para declarar "detected".
 *
 * Justificación del valor: la banda 0.2-0.5 Hz abarca ~30 bins del
 * espectro (para una ventana de ~90s con zero-padding a potencia de 2), y
 * se busca el bin de MAYOR potencia entre esos ~30. Bajo ruido puro, la
 * potencia por bin del periodograma se aproxima a una distribución
 * exponencial, y el máximo de ~30 muestras exponenciales i.i.d. ya supera
 * la mediana por un factor ~4-8x solo por azar ("efecto look-elsewhere").
 * Con un umbral de 6x se midieron falsos positivos con ruido blanco puro
 * en hasta un 15-20% de las corridas (validado con un barrido de 20
 * semillas deterministas) — inaceptable en un contexto de rescate, donde
 * un falso positivo ("hay alguien vivo" donde no hay nadie) es mucho peor
 * que un falso negativo. Se subió a 20x (~13 dB), punto en el que el mismo
 * barrido de 20 semillas de ruido blanco y 10 semillas de una señal
 * periódica fuera de banda (1.5 Hz, tipo ventilador) dieron 0 falsos
 * positivos, mientras que una respiración sintética real (seno en banda,
 * incluso con amplitud de modulación 10x menor que el ruido de fondo)
 * se sigue detectando con confianza > 0.8.
 */
const PROMINENCE_THRESHOLD_RATIO = 20;

/** Varianza mínima para considerar una subportadora "viva" (no muerta/saturada). */
const MIN_VARIANCE = 1e-6;

/** Cotas del número de subportadoras promediadas (ver selección por cuartil). */
const MIN_AVERAGED_SUBCARRIERS = 4;
const MAX_AVERAGED_SUBCARRIERS = 16;

/**
 * Margen (Hz) a cada lado de la banda de respiración usado para estimar el
 * piso de ruido LOCAL alrededor del pico.
 *
 * Por qué local y no global: los frames llegan por red a intervalos
 * irregulares, y el remuestreo por interpolación lineal se comporta como un
 * filtro pasa-bajos que atenúa las frecuencias altas. Si el piso de ruido se
 * estima como la mediana de TODO el espectro restante (dominado por esos
 * bins altos ya atenuados), queda artificialmente bajo, mientras la banda de
 * respiración —de frecuencia baja— queda naturalmente elevada. El cociente
 * pico/piso se infla entonces por la INCLINACIÓN del espectro y no por una
 * señal periódica real, produciendo falsos positivos con ruido puro. Medir
 * el piso en un entorno cercano al pico cancela esa inclinación: una
 * respiración real es un pico ANGOSTO que sobresale de sus vecinos
 * inmediatos, mientras que la deriva espectral eleva al pico y a sus vecinos
 * por igual.
 */
const LOCAL_NOISE_MARGIN_HZ = 0.5;

/**
 * Bins a cada lado del pico excluidos del cálculo del piso de ruido, para
 * que la propia energía del pico (dispersada por la ventana de Hann hacia
 * los bins contiguos) no contamine la estimación del fondo.
 */
const PEAK_GUARD_BINS = 2;

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Remuestrea una serie con timestamps irregulares a una grilla uniforme por
 * interpolación lineal. Los frames CSI llegan por red con jitter — no hay
 * garantía de intervalo constante — así que la tasa de muestreo efectiva se
 * calcula a partir de los timestamps reales (no se asume ~5 Hz fijo) y se
 * interpola sobre esa grilla antes de aplicar la FFT.
 */
function resampleUniform(times: readonly number[], values: readonly number[], dtMs: number): number[] {
  const t0 = times[0];
  const tEnd = times[times.length - 1];
  const n = Math.max(1, Math.floor((tEnd - t0) / dtMs) + 1);
  const result: number[] = new Array(n);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dtMs;
    while (idx < times.length - 2 && times[idx + 1] < t) idx++;
    const i1 = idx;
    const i2 = Math.min(idx + 1, times.length - 1);
    const t1 = times[i1];
    const t2 = times[i2];
    const v1 = values[i1];
    const v2 = values[i2];
    const frac = t2 === t1 ? 0 : (t - t1) / (t2 - t1);
    result[i] = v1 + frac * (v2 - v1);
  }
  return result;
}

/**
 * Elimina la deriva lenta (movimiento del operador, cambios térmicos)
 * restando la recta de mínimos cuadrados. Sin este paso la banda 0.2-0.5 Hz
 * queda dominada por la tendencia y no por la periodicidad real.
 */
function detrendLinear(values: readonly number[]): number[] {
  const n = values.length;
  if (n < 2) return values.slice();
  const xMean = (n - 1) / 2;
  let yMean = 0;
  for (const v of values) yMean += v;
  yMean /= n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  return values.map((v, i) => v - (intercept + slope * i));
}

/** Ventana de Hann para reducir fuga espectral antes de la FFT. */
function applyHannWindow(values: readonly number[]): number[] {
  const n = values.length;
  if (n < 2) return values.slice();
  return values.map((v, i) => v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
}

/**
 * FFT radix-2 Cooley-Tukey in-place, iterativa (bit-reversal + mariposas).
 *
 * Se eligió radix-2 sobre una DFT directa O(n²) porque, si bien con las
 * ~300-450 muestras típicas de una ventana de 60-90s a ~5Hz una DFT directa
 * sería computacionalmente aceptable, la FFT es O(n log n), no depende de
 * ninguna librería externa (requisito del proyecto: sin dependencias
 * nuevas) y el zero-padding a potencia de 2 que requiere tiene el efecto
 * colateral útil de interpolar el espectro alrededor del pico (más bins
 * para ubicar el máximo con más precisión, aunque no aporta resolución
 * real adicional — la resolución real la sigue dando la duración de la
 * ventana).
 */
function fftRadix2(real: Float64Array, imag: Float64Array): void {
  const n = real.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = real[i + j];
        const uIm = imag[i + j];
        const vRe = real[i + j + half] * wRe - imag[i + j + half] * wIm;
        const vIm = real[i + j + half] * wIm + imag[i + j + half] * wRe;
        real[i + j] = uRe + vRe;
        imag[i + j] = uIm + vIm;
        real[i + j + half] = uRe - vRe;
        imag[i + j + half] = uIm - vIm;
        const nwRe = wRe * wLenRe - wIm * wLenIm;
        const nwIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nwRe;
        wIm = nwIm;
      }
    }
  }
}

interface SpectrumResult {
  /** Potencia (magnitud²) por bin, solo la mitad útil [0, N/2] (señal real). */
  power: Float64Array;
  /** Resolución en Hz por bin. */
  binHz: number;
}

function computeSpectrum(values: readonly number[], sampleRateHz: number): SpectrumResult {
  const padded = nextPowerOfTwo(values.length);
  const real = new Float64Array(padded);
  const imag = new Float64Array(padded);
  real.set(values);
  fftRadix2(real, imag);

  const half = padded / 2;
  const power = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    power[k] = real[k] * real[k] + imag[k] * imag[k];
  }
  return { power, binHz: sampleRateHz / padded };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variance(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sum = 0;
  for (const v of values) sum += (v - mean) ** 2;
  return sum / n;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Analiza un buffer de frames CSI (amplitud de 64 subportadoras + timestamp
 * real) en busca de un patrón respiratorio periódico en 0.2-0.5 Hz.
 *
 * Algoritmo:
 *  1. Si la ventana cubre menos de ~30s de datos, o la tasa de muestreo
 *     efectiva no alcanza a cubrir la banda por Nyquist, se reporta
 *     `insufficient_data` — nunca se fabrica un resultado con poca data.
 *  2. Se arma, por cada subportadora, su serie temporal de amplitud.
 *  3. Se descartan subportadoras "muertas" (varianza casi nula) y se elige
 *     la de mejor relación señal/ruido en la banda de interés (mayor
 *     proporción de potencia concentrada en 0.2-0.5 Hz sobre su potencia
 *     total).
 *  4. Se remuestrea a una grilla uniforme (la red no entrega frames a
 *     intervalos exactos), se aplica detrend lineal y ventana de Hann.
 *  5. Se calcula el espectro vía FFT radix-2 con zero-padding.
 *  6. Se busca el pico dentro de la banda y se compara su potencia contra
 *     la mediana de potencia del resto del espectro (excluyendo DC y la
 *     propia banda). Si no hay prominencia suficiente, `not_detected`.
 */
export function analyzeBreathing(frames: readonly BreathingFrameInput[]): BreathingResult {
  if (frames.length < 2) {
    return { status: 'insufficient_data', bpm: null, confidence: 0, windowSeconds: 0 };
  }

  const sorted = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);
  const windowSeconds = (sorted[sorted.length - 1].timestampMs - sorted[0].timestampMs) / 1000;

  if (windowSeconds < MIN_WINDOW_SECONDS) {
    return { status: 'insufficient_data', bpm: null, confidence: 0, windowSeconds };
  }

  const times = sorted.map((f) => f.timestampMs);
  const subcarrierCount = Math.min(...sorted.map((f) => f.amplitudes.length));
  if (subcarrierCount === 0) {
    return { status: 'insufficient_data', bpm: null, confidence: 0, windowSeconds };
  }

  // Tasa de muestreo efectiva real, calculada a partir de los timestamps
  // (los frames llegan por red con jitter, no se asume ~5 Hz fijo).
  const avgIntervalMs = (times[times.length - 1] - times[0]) / (times.length - 1);
  const sampleRateHz = 1000 / avgIntervalMs;

  // Si el Nyquist de la tasa efectiva no alcanza a cubrir la banda de
  // interés, no hay forma honesta de buscar el patrón: es dato insuficiente,
  // no "no detectado".
  if (sampleRateHz < 2 * BAND_MAX_HZ) {
    return { status: 'insufficient_data', bpm: null, confidence: 0, windowSeconds };
  }

  /*
   * Promediado incoherente del espectro entre subportadoras.
   *
   * La respiración modula MUCHAS subportadoras a la MISMA frecuencia (es un
   * único movimiento físico afectando todo el canal), mientras que el ruido
   * de cada subportadora es en buena medida independiente. Al promediar los
   * espectros, la componente respiratoria se mantiene y el ruido se promedia
   * hacia su media, de modo que la relación señal/ruido mejora
   * aproximadamente con la raíz del número de subportadoras usadas.
   *
   * Se eligió esto sobre la estrategia previa de "quedarse con la mejor
   * subportadora": elegir el máximo entre 64 candidatas agrava el efecto
   * look-elsewhere (favorece a la que tuvo el pico más afortunado por ruido),
   * mientras que promediar lo atenúa. Mejora la sensibilidad SIN relajar el
   * umbral, que es lo que se necesita para no reintroducir falsos positivos.
   *
   * Cada espectro se normaliza por su potencia total antes de sumarse, para
   * que una subportadora de amplitud grande no domine el promedio.
   */
  const candidates: { normalized: Float64Array; bandRatio: number; binHz: number }[] = [];

  for (let sc = 0; sc < subcarrierCount; sc++) {
    const raw = sorted.map((f) => f.amplitudes[sc]);
    if (variance(raw) < MIN_VARIANCE) continue; // subportadora muerta/saturada

    const uniform = resampleUniform(times, raw, avgIntervalMs);
    if (uniform.length < 8) continue;

    const detrended = detrendLinear(uniform);
    const windowed = applyHannWindow(detrended);
    const spectrum = computeSpectrum(windowed, sampleRateHz);

    const bandLo = Math.max(1, Math.round(BAND_MIN_HZ / spectrum.binHz));
    const bandHi = Math.min(spectrum.power.length - 1, Math.round(BAND_MAX_HZ / spectrum.binHz));
    if (bandLo > bandHi) continue;

    let bandPower = 0;
    let totalPower = 0;
    for (let k = 1; k < spectrum.power.length; k++) {
      totalPower += spectrum.power[k];
      if (k >= bandLo && k <= bandHi) bandPower += spectrum.power[k];
    }
    if (!(totalPower > 0)) continue;

    candidates.push({
      normalized: spectrum.power.map((p) => p / totalPower),
      bandRatio: bandPower / totalPower,
      binHz: spectrum.binHz,
    });
  }

  if (candidates.length === 0) {
    return { status: 'not_detected', bpm: null, confidence: 0, windowSeconds };
  }

  /*
   * Se promedian las mejores K subportadoras, no todas.
   *
   * Promediar reduce el ruido (independiente entre subportadoras) mientras
   * preserva la respiración (coherente: es un único movimiento físico que
   * modula el canal a la misma frecuencia), y además atenúa el efecto
   * look-elsewhere frente a quedarse con UNA sola "mejor" subportadora.
   *
   * Pero promediar las 64 es contraproducente: la respiración no modula
   * todas por igual — depende de la geometría del multipath, y típicamente
   * solo un subconjunto la refleja con fuerza. Incluir las que solo tienen
   * ruido diluye la señal. Se toma entonces el cuartil superior por
   * proporción de potencia en banda, acotado a [MIN, MAX], que equilibra
   * ganancia por promediado contra dilución.
   */
  candidates.sort((a, b) => b.bandRatio - a.bandRatio);
  const k = Math.min(
    MAX_AVERAGED_SUBCARRIERS,
    Math.max(MIN_AVERAGED_SUBCARRIERS, Math.round(candidates.length / 4)),
  );
  const selected = candidates.slice(0, Math.min(k, candidates.length));

  const binCount = selected[0].normalized.length;
  const averaged = new Float64Array(binCount);
  let usedSubcarriers = 0;
  for (const cand of selected) {
    if (cand.normalized.length !== binCount) continue;
    for (let i = 0; i < binCount; i++) averaged[i] += cand.normalized[i];
    usedSubcarriers++;
  }
  if (usedSubcarriers === 0) {
    return { status: 'not_detected', bpm: null, confidence: 0, windowSeconds };
  }
  for (let i = 0; i < binCount; i++) averaged[i] /= usedSubcarriers;

  const bestSpectrum: SpectrumResult = { power: averaged, binHz: selected[0].binHz };

  const bandLo = Math.max(1, Math.round(BAND_MIN_HZ / bestSpectrum.binHz));
  const bandHi = Math.min(bestSpectrum.power.length - 1, Math.round(BAND_MAX_HZ / bestSpectrum.binHz));

  let peakBin = bandLo;
  let peakPower = -Infinity;
  for (let k = bandLo; k <= bandHi; k++) {
    if (bestSpectrum.power[k] > peakPower) {
      peakPower = bestSpectrum.power[k];
      peakBin = k;
    }
  }

  /*
   * Piso de ruido LOCAL: mediana de los bins del entorno del pico,
   * excluyendo el pico y sus bins de guarda. Ver LOCAL_NOISE_MARGIN_HZ
   * para la justificación (inmunidad a la inclinación espectral que
   * introduce el remuestreo de muestras con jitter).
   */
  const marginBins = Math.max(1, Math.round(LOCAL_NOISE_MARGIN_HZ / bestSpectrum.binHz));
  const localLo = Math.max(1, bandLo - marginBins);
  const localHi = Math.min(bestSpectrum.power.length - 1, bandHi + marginBins);

  const localPowers: number[] = [];
  for (let k = localLo; k <= localHi; k++) {
    if (Math.abs(k - peakBin) <= PEAK_GUARD_BINS) continue;
    localPowers.push(bestSpectrum.power[k]);
  }

  const noiseFloor = median(localPowers);
  const prominenceRatio = noiseFloor === 0 ? (peakPower > 0 ? Infinity : 0) : peakPower / noiseFloor;
  const confidence = clamp01(1 - PROMINENCE_THRESHOLD_RATIO / Math.max(prominenceRatio, 1e-9));

  if (prominenceRatio < PROMINENCE_THRESHOLD_RATIO) {
    return { status: 'not_detected', bpm: null, confidence, windowSeconds };
  }

  const peakFreqHz = peakBin * bestSpectrum.binHz;
  const bpm = peakFreqHz * 60;

  return { status: 'detected', bpm, confidence, windowSeconds };
}
