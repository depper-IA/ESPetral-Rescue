/**
 * Módulo de procesamiento de audio para detección acústica.
 * Incluye el motor de Web Audio API, funciones puras de procesamiento,
 * y detección de patrones de golpe (knock patterns).
 */
export {
  classifyPeak,
  computeRms,
  INITIAL_NOISE_FLOOR,
  NOISE_FLOOR_ALPHA,
  PEAK_ABSOLUTE_THRESHOLD,
  PEAK_NOISE_MULTIPLIER,
  updateNoiseFloor,
} from './audio-processing';

export {
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
export type { KnockPatternResult } from './knock-detection';

export { useAudioEngine } from './useAudioEngine';
export type { AudioEngineControls, AudioEngineState } from './useAudioEngine';

export { useKnockDetector } from './useKnockDetector';
export type {
  KnockDetectorControls,
  KnockDetectorOptions,
  KnockDetectorState,
  KnockPatternEvent,
} from './useKnockDetector';

export { useAudioVisualizer } from './useAudioVisualizer';
export type { AudioVisualizerRefs } from './useAudioVisualizer';

export { AudioVisualizers } from './AudioVisualizers';
export type { AudioVisualizersProps } from './AudioVisualizers';

export { AudioDebugPanel } from './AudioDebugPanel';
export type { AudioDebugPanelProps } from './AudioDebugPanel';

export { KnockStatus } from './KnockStatus';
export type { KnockStatusProps } from './KnockStatus';
