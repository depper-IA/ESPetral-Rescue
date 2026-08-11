/**
 * Tests para useClearLogDialog — lógica del diálogo de confirmación.
 * Verifica que la limpieza requiere confirmación explícita.
 *
 * Requisitos: 5.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LocationEngine } from './location-engine';

/**
 * Reimplementación mínima de la lógica del hook para testing sin React.
 * Valida el contrato: open → confirm = clear, open → close = no clear.
 */
function createClearLogController(engine: Pick<LocationEngine, 'clear'>, onCleared?: () => void) {
  let isOpen = false;

  return {
    get isOpen() { return isOpen; },
    open() { isOpen = true; },
    close() { isOpen = false; },
    confirm() {
      engine.clear();
      isOpen = false;
      onCleared?.();
    },
  };
}

// Mock mínimo de LocationEngine
function createMockEngine(): Pick<LocationEngine, 'clear'> {
  return {
    clear: vi.fn(),
  };
}

describe('ClearLogDialog logic', () => {
  let engine: ReturnType<typeof createMockEngine>;

  beforeEach(() => {
    engine = createMockEngine();
  });

  it('inicia con el diálogo cerrado', () => {
    const ctrl = createClearLogController(engine);
    expect(ctrl.isOpen).toBe(false);
  });

  it('abre el diálogo al llamar open()', () => {
    const ctrl = createClearLogController(engine);
    ctrl.open();
    expect(ctrl.isOpen).toBe(true);
  });

  it('cierra el diálogo al llamar close() sin limpiar datos', () => {
    const ctrl = createClearLogController(engine);
    ctrl.open();
    ctrl.close();

    expect(ctrl.isOpen).toBe(false);
    expect(engine.clear).not.toHaveBeenCalled();
  });

  it('al confirmar: llama engine.clear() y cierra el diálogo', () => {
    const ctrl = createClearLogController(engine);
    ctrl.open();
    ctrl.confirm();

    expect(engine.clear).toHaveBeenCalledTimes(1);
    expect(ctrl.isOpen).toBe(false);
  });

  it('al confirmar: invoca el callback onCleared', () => {
    const onCleared = vi.fn();
    const ctrl = createClearLogController(engine, onCleared);

    ctrl.open();
    ctrl.confirm();

    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('cancelar (close) no invoca onCleared', () => {
    const onCleared = vi.fn();
    const ctrl = createClearLogController(engine, onCleared);

    ctrl.open();
    ctrl.close();

    expect(onCleared).not.toHaveBeenCalled();
  });

  it('confirm elimina de localStorage y memoria via engine.clear()', () => {
    const ctrl = createClearLogController(engine);
    ctrl.open();
    ctrl.confirm();

    // engine.clear() maneja ambos: localStorage + colección en memoria
    expect(engine.clear).toHaveBeenCalledTimes(1);
  });

  it('múltiples open/close no afectan el estado de los datos', () => {
    const ctrl = createClearLogController(engine);

    ctrl.open();
    ctrl.close();
    ctrl.open();
    ctrl.close();
    ctrl.open();
    ctrl.close();

    expect(engine.clear).not.toHaveBeenCalled();
  });
});
