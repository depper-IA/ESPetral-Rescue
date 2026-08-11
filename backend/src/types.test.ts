/**
 * ESPetral Rescue — Tests para funciones de tipos
 *
 * Verifica que la función probabilityToColor mapea correctamente
 * los valores de probabilidad a los colores del dashboard.
 *
 * Requisitos: 7.2
 */

import { describe, it, expect } from 'vitest';
import { probabilityToColor } from './types.js';

describe('probabilityToColor', () => {
  it('retorna "grey" cuando la probabilidad es null (sin datos)', () => {
    expect(probabilityToColor(null)).toBe('grey');
  });

  it('retorna "green" cuando la probabilidad es menor a 0.3', () => {
    expect(probabilityToColor(0)).toBe('green');
    expect(probabilityToColor(0.1)).toBe('green');
    expect(probabilityToColor(0.29)).toBe('green');
    expect(probabilityToColor(0.299)).toBe('green');
  });

  it('retorna "yellow" cuando la probabilidad es >= 0.3 y < 0.6', () => {
    expect(probabilityToColor(0.3)).toBe('yellow');
    expect(probabilityToColor(0.45)).toBe('yellow');
    expect(probabilityToColor(0.59)).toBe('yellow');
    expect(probabilityToColor(0.599)).toBe('yellow');
  });

  it('retorna "red" cuando la probabilidad es >= 0.6', () => {
    expect(probabilityToColor(0.6)).toBe('red');
    expect(probabilityToColor(0.75)).toBe('red');
    expect(probabilityToColor(1.0)).toBe('red');
  });

  it('maneja valores de frontera exactos correctamente', () => {
    // Frontera verde/amarillo: 0.3
    expect(probabilityToColor(0.2999999)).toBe('green');
    expect(probabilityToColor(0.3)).toBe('yellow');

    // Frontera amarillo/rojo: 0.6
    expect(probabilityToColor(0.5999999)).toBe('yellow');
    expect(probabilityToColor(0.6)).toBe('red');
  });
});
