/**
 * ESPetral Rescue — Tests unitarios para el motor de puntuación compuesta
 *
 * Valida la redistribución de pesos, exclusión por staleness,
 * umbral de alerta prioritaria, y cálculo compuesto correcto.
 *
 * Requisitos: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import { describe, it, expect } from 'vitest';
import {
  isSourceActive,
  redistributeWeights,
  computeCompositeScore,
  shouldEmitPriorityAlert,
  STALENESS_THRESHOLD_MS,
  type SourceData,
} from './scoring-engine.js';

describe('ScoringEngine — isSourceActive', () => {
  it('devuelve true si el último reporte fue hace menos de 10 minutos', () => {
    const now = new Date('2024-06-01T12:00:00Z');
    const lastReport = new Date('2024-06-01T11:55:00Z'); // 5 min atrás
    expect(isSourceActive(lastReport, now)).toBe(true);
  });

  it('devuelve true si el último reporte fue exactamente hace 10 minutos', () => {
    const now = new Date('2024-06-01T12:00:00Z');
    const lastReport = new Date(now.getTime() - STALENESS_THRESHOLD_MS); // 10 min exactos
    expect(isSourceActive(lastReport, now)).toBe(true);
  });

  it('devuelve false si el último reporte fue hace más de 10 minutos', () => {
    const now = new Date('2024-06-01T12:00:00Z');
    const lastReport = new Date('2024-06-01T11:49:59Z'); // 10 min 1 seg atrás
    expect(isSourceActive(lastReport, now)).toBe(false);
  });
});

describe('ScoringEngine — redistributeWeights', () => {
  it('retorna pesos originales cuando las 3 fuentes están disponibles', () => {
    const weights = redistributeWeights(['csi', 'acoustic', 'gps']);
    expect(weights.csi).toBeCloseTo(0.50);
    expect(weights.acoustic).toBeCloseTo(0.35);
    expect(weights.gps).toBeCloseTo(0.15);
  });

  it('redistribuye CSI + acoustic: CSI=58.8%, acoustic=41.2%', () => {
    const weights = redistributeWeights(['csi', 'acoustic']);
    // CSI = 50/(50+35) = 0.5882...
    expect(weights.csi).toBeCloseTo(50 / 85, 4);
    // acoustic = 35/(50+35) = 0.4118...
    expect(weights.acoustic).toBeCloseTo(35 / 85, 4);
    expect(weights.gps).toBeUndefined();
  });

  it('redistribuye CSI solo: CSI=100%', () => {
    const weights = redistributeWeights(['csi']);
    expect(weights.csi).toBeCloseTo(1.0);
    expect(weights.acoustic).toBeUndefined();
    expect(weights.gps).toBeUndefined();
  });

  it('redistribuye acoustic + GPS: acoustic=70%, GPS=30%', () => {
    const weights = redistributeWeights(['acoustic', 'gps']);
    // acoustic = 35/(35+15) = 0.70
    expect(weights.acoustic).toBeCloseTo(0.70);
    // gps = 15/(35+15) = 0.30
    expect(weights.gps).toBeCloseTo(0.30);
    expect(weights.csi).toBeUndefined();
  });

  it('redistribuye CSI + GPS: CSI=76.9%, GPS=23.1%', () => {
    const weights = redistributeWeights(['csi', 'gps']);
    expect(weights.csi).toBeCloseTo(50 / 65, 4);
    expect(weights.gps).toBeCloseTo(15 / 65, 4);
  });

  it('retorna objeto vacío cuando no hay fuentes', () => {
    const weights = redistributeWeights([]);
    expect(weights).toEqual({});
  });

  it('los pesos siempre suman 1.0 para cualquier combinación', () => {
    const combos: Array<Array<'csi' | 'acoustic' | 'gps'>> = [
      ['csi'],
      ['acoustic'],
      ['gps'],
      ['csi', 'acoustic'],
      ['csi', 'gps'],
      ['acoustic', 'gps'],
      ['csi', 'acoustic', 'gps'],
    ];

    for (const combo of combos) {
      const weights = redistributeWeights(combo);
      const sum = Object.values(weights).reduce((a, b) => a + (b ?? 0), 0);
      expect(sum).toBeCloseTo(1.0);
    }
  });
});

describe('ScoringEngine — computeCompositeScore', () => {
  const now = new Date('2024-06-01T12:00:00Z');
  const recentReport = new Date('2024-06-01T11:55:00Z'); // 5 min atrás
  const staleReport = new Date('2024-06-01T11:49:00Z'); // 11 min atrás

  it('retorna null cuando no hay fuentes', () => {
    const result = computeCompositeScore({}, now);
    expect(result).toBeNull();
  });

  it('retorna null cuando todas las fuentes son stale', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0.8, lastReport: staleReport },
      acoustic: { value: 0.6, lastReport: staleReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).toBeNull();
  });

  it('calcula correctamente con las 3 fuentes activas', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0.8, lastReport: recentReport },
      acoustic: { value: 0.6, lastReport: recentReport },
      gps: { value: 1.0, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    // 0.8*0.50 + 0.6*0.35 + 1.0*0.15 = 0.40 + 0.21 + 0.15 = 0.76 → 76
    expect(result!.score).toBe(76);
  });

  it('excluye fuentes stale y redistribuye pesos', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0.8, lastReport: recentReport },
      acoustic: { value: 0.6, lastReport: staleReport }, // stale → excluida
      gps: { value: 1.0, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    // Solo CSI + GPS: CSI=50/65, GPS=15/65
    // 0.8*(50/65) + 1.0*(15/65) = 0.6154 + 0.2308 = 0.8462 → 85
    expect(result!.score).toBe(85);
    expect(result!.sources.acoustic).toBeNull();
    expect(result!.sources.csi).not.toBeNull();
    expect(result!.sources.gps).not.toBeNull();
  });

  it('calcula con solo una fuente activa (peso 100%)', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0.65, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    // 0.65 * 1.0 = 0.65 → 65
    expect(result!.score).toBe(65);
    expect(result!.sources.acoustic).toBeNull();
    expect(result!.sources.gps).toBeNull();
  });

  it('el resultado es un entero en el rango [0, 100]', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0.333, lastReport: recentReport },
      acoustic: { value: 0.777, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    expect(Number.isInteger(result!.score)).toBe(true);
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(100);
  });

  it('retorna score=0 cuando todas las fuentes tienen value=0', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 0, lastReport: recentReport },
      acoustic: { value: 0, lastReport: recentReport },
      gps: { value: 0, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
  });

  it('retorna score=100 cuando todas las fuentes tienen value=1.0', () => {
    const sources: Partial<Record<'csi' | 'acoustic' | 'gps', SourceData>> = {
      csi: { value: 1.0, lastReport: recentReport },
      acoustic: { value: 1.0, lastReport: recentReport },
      gps: { value: 1.0, lastReport: recentReport },
    };
    const result = computeCompositeScore(sources, now);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(100);
  });
});

describe('ScoringEngine — shouldEmitPriorityAlert', () => {
  it('NO emite alerta cuando score es exactamente 70', () => {
    expect(shouldEmitPriorityAlert(70)).toBe(false);
  });

  it('emite alerta cuando score es 71', () => {
    expect(shouldEmitPriorityAlert(71)).toBe(true);
  });

  it('emite alerta cuando score es 100', () => {
    expect(shouldEmitPriorityAlert(100)).toBe(true);
  });

  it('NO emite alerta cuando score es 0', () => {
    expect(shouldEmitPriorityAlert(0)).toBe(false);
  });

  it('NO emite alerta cuando score es 69', () => {
    expect(shouldEmitPriorityAlert(69)).toBe(false);
  });
});
