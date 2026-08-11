/**
 * Tests unitarios y de propiedades para el módulo de compartir ubicación.
 * Verifica formato del texto, Web Share API, fallback clipboard, y caso vacío.
 *
 * Requisitos: 2.1, 2.2, 2.3, 2.4
 * Valida: Property 4 — Share text contiene todos los campos en orden.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import type { LocationEntry } from './location-engine';
import {
  formatShareText,
  shareLocation,
  isShareAvailable,
  isClipboardAvailable,
  showClipboardConfirmation,
} from './share-location';

// --- Helpers ---

function makeEntry(overrides: Partial<LocationEntry> = {}): LocationEntry {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2024-01-15T10:30:00.000Z',
    lat: 3.4516,
    lon: -76.5320,
    accuracy: 12.5,
    note: 'Posible señal en sector norte',
    synced: false,
    ...overrides,
  };
}

// --- Tests unitarios: formatShareText ---

describe('formatShareText', () => {
  it('debe contener todos los campos en el orden correcto', () => {
    const entry = makeEntry();
    const text = formatShareText(entry);
    const lines = text.split('\n');

    expect(lines[0]).toBe('Ubicación registrada');
    expect(lines[1]).toMatch(/^Fecha: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(lines[2]).toBe('Precisión: 12.5m');
    expect(lines[3]).toBe('Nota: Posible señal en sector norte');
    expect(lines[4]).toBe('Coordenadas: 3.4516, -76.532');
    expect(lines[5]).toBe('Mapa: https://maps.google.com/?q=3.4516,-76.532');
  });

  it('debe incluir Google Maps link con formato correcto', () => {
    const entry = makeEntry({ lat: -34.6037, lon: -58.3816 });
    const text = formatShareText(entry);

    expect(text).toContain('https://maps.google.com/?q=-34.6037,-58.3816');
  });

  it('debe manejar nota vacía', () => {
    const entry = makeEntry({ note: '' });
    const text = formatShareText(entry);

    expect(text).toContain('Nota: ');
  });

  it('debe manejar coordenadas con muchos decimales', () => {
    const entry = makeEntry({ lat: 3.451600123, lon: -76.532000456 });
    const text = formatShareText(entry);

    expect(text).toContain('Coordenadas: 3.451600123, -76.532000456');
    expect(text).toContain('Mapa: https://maps.google.com/?q=3.451600123,-76.532000456');
  });

  it('debe formatear la fecha en formato local legible', () => {
    const entry = makeEntry({ timestamp: '2024-06-15T14:30:45.000Z' });
    const text = formatShareText(entry);

    // La fecha se formatea en hora local del dispositivo
    expect(text).toMatch(/Fecha: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });
});

// --- Tests unitarios: shareLocation ---

describe('shareLocation', () => {
  beforeEach(() => {
    // Resetear navigator mocks
    vi.stubGlobal('navigator', {
      share: undefined,
      clipboard: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe retornar error cuando no hay entrada (Req 2.3)', async () => {
    const result = await shareLocation(null);

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
    expect(result.message).toBe('No hay ubicación registrada para compartir');
  });

  it('debe retornar error cuando la entrada es undefined (Req 2.3)', async () => {
    const result = await shareLocation(undefined);

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
    expect(result.message).toBe('No hay ubicación registrada para compartir');
  });

  it('debe usar Web Share API cuando está disponible (Req 2.1)', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share: shareMock, clipboard: undefined });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(true);
    expect(result.method).toBe('share');
    expect(shareMock).toHaveBeenCalledWith({ text: formatShareText(entry) });
  });

  it('debe hacer fallback a clipboard cuando Web Share no está disponible (Req 2.2)', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: undefined,
      clipboard: { writeText: writeTextMock },
    });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(true);
    expect(result.method).toBe('clipboard');
    expect(result.message).toBe('Copiado al portapapeles');
    expect(writeTextMock).toHaveBeenCalledWith(formatShareText(entry));
  });

  it('debe hacer fallback a clipboard cuando Web Share falla con error no-abort', async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error('NetworkError'));
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: shareMock,
      clipboard: { writeText: writeTextMock },
    });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(true);
    expect(result.method).toBe('clipboard');
  });

  it('debe retornar cancelado cuando el usuario cierra el diálogo de compartir', async () => {
    const abortError = new Error('User aborted');
    abortError.name = 'AbortError';
    const shareMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('navigator', { share: shareMock, clipboard: undefined });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(false);
    expect(result.method).toBe('share');
    expect(result.message).toBe('Compartir cancelado por el usuario');
  });

  it('debe retornar error cuando ni share ni clipboard están disponibles', async () => {
    vi.stubGlobal('navigator', { share: undefined, clipboard: undefined });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
    expect(result.message).toBe('Compartir no disponible en este dispositivo');
  });

  it('debe manejar error de clipboard', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
    vi.stubGlobal('navigator', {
      share: undefined,
      clipboard: { writeText: writeTextMock },
    });

    const entry = makeEntry();
    const result = await shareLocation(entry);

    expect(result.success).toBe(false);
    expect(result.method).toBe('clipboard');
    expect(result.message).toBe('No se pudo copiar al portapapeles');
  });
});

// --- Tests de detección de APIs ---

describe('isShareAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe retornar true cuando navigator.share es una función', () => {
    vi.stubGlobal('navigator', { share: vi.fn() });
    expect(isShareAvailable()).toBe(true);
  });

  it('debe retornar false cuando navigator.share no existe', () => {
    vi.stubGlobal('navigator', {});
    expect(isShareAvailable()).toBe(false);
  });
});

describe('isClipboardAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe retornar true cuando clipboard.writeText es una función', () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    expect(isClipboardAvailable()).toBe(true);
  });

  it('debe retornar false cuando clipboard no existe', () => {
    vi.stubGlobal('navigator', {});
    expect(isClipboardAvailable()).toBe(false);
  });
});

// --- Property-based test ---

/**
 * **Validates: Requirements 2.1, 2.4**
 * Property 4: Share text contiene todos los campos en orden exacto:
 * timestamp, accuracy, note, coordinates "lat, lon", Google Maps link.
 */
describe('Property 4: formatShareText completeness', () => {
  const locationEntryArb = fc.record({
    id: fc.uuid(),
    timestamp: fc.integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
      .map(ms => new Date(ms).toISOString()),
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    accuracy: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
    note: fc.string({ minLength: 0, maxLength: 200 }),
    synced: fc.boolean(),
  });

  it('debe contener todos los campos obligatorios en el orden correcto para cualquier entrada válida', () => {
    fc.assert(
      fc.property(locationEntryArb, (entry) => {
        const text = formatShareText(entry);
        const lines = text.split('\n');

        // Línea 0: header
        expect(lines[0]).toBe('Ubicación registrada');

        // Línea 1: timestamp (fecha formateada)
        expect(lines[1]).toMatch(/^Fecha: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

        // Línea 2: accuracy en metros
        expect(lines[2]).toBe(`Precisión: ${entry.accuracy}m`);

        // Línea 3: nota
        expect(lines[3]).toBe(`Nota: ${entry.note}`);

        // Línea 4: coordenadas
        expect(lines[4]).toBe(`Coordenadas: ${entry.lat}, ${entry.lon}`);

        // Línea 5: Google Maps link
        expect(lines[5]).toBe(`Mapa: https://maps.google.com/?q=${entry.lat},${entry.lon}`);

        // Exactamente 6 líneas
        expect(lines).toHaveLength(6);
      }),
      { numRuns: 100 }
    );
  });

  it('el enlace de Google Maps debe coincidir con el patrón correcto', () => {
    fc.assert(
      fc.property(locationEntryArb, (entry) => {
        const text = formatShareText(entry);
        const mapsLinkPattern = `https://maps.google.com/?q=${entry.lat},${entry.lon}`;
        expect(text).toContain(mapsLinkPattern);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Tests: showClipboardConfirmation (Req 2.4) ---
// Requiere DOM real — usamos jsdom solo para este describe block.

/** @vitest-environment jsdom */
describe('showClipboardConfirmation', () => {
  beforeEach(() => {
    // Limpiar cualquier toast residual
    document.querySelectorAll('[data-testid="cali-clipboard-toast"]').forEach(el => el.remove());
    document.getElementById('cali-clipboard-toast-styles')?.remove();
  });

  it('debe crear un toast en el DOM con role=status', () => {
    const dismiss = showClipboardConfirmation();

    const toast = document.querySelector('[data-testid="cali-clipboard-toast"]');
    expect(toast).not.toBeNull();
    expect(toast?.getAttribute('role')).toBe('status');
    expect(toast?.getAttribute('aria-live')).toBe('polite');
    expect(toast?.textContent).toBe('Copiado al portapapeles');

    dismiss(); // cleanup
  });

  it('debe usar mensaje custom cuando se provee', () => {
    const dismiss = showClipboardConfirmation('Ubicación copiada');

    const toast = document.querySelector('[data-testid="cali-clipboard-toast"]');
    expect(toast?.textContent).toBe('Ubicación copiada');

    dismiss();
  });

  it('debe eliminarse automáticamente después de durationMs (default 2000)', () => {
    vi.useFakeTimers();
    try {
      showClipboardConfirmation();

      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).not.toBeNull();

      // Avanzar tiempo a 1999ms — toast aún presente
      vi.advanceTimersByTime(1999);
      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).not.toBeNull();

      // Avanzar 1ms más — toast debe haberse eliminado
      vi.advanceTimersByTime(1);
      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debe respetar durationMs custom', () => {
    vi.useFakeTimers();
    try {
      showClipboardConfirmation('Copiado', 500);

      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).not.toBeNull();

      vi.advanceTimersByTime(499);
      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).not.toBeNull();

      vi.advanceTimersByTime(1);
      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('la función de cancelación manual debe eliminar el toast antes del timeout', () => {
    vi.useFakeTimers();
    try {
      const dismiss = showClipboardConfirmation();

      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).not.toBeNull();

      dismiss();

      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).toBeNull();

      // Avanzar el tiempo: no debe haber errores ni recrear el toast
      vi.advanceTimersByTime(5000);
      expect(document.querySelector('[data-testid="cali-clipboard-toast"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debe inyectar estilos CSS de animación una sola vez', () => {
    showClipboardConfirmation();
    const firstStyle = document.getElementById('cali-clipboard-toast-styles');
    expect(firstStyle).not.toBeNull();

    showClipboardConfirmation();
    showClipboardConfirmation();
    const styles = document.querySelectorAll('#cali-clipboard-toast-styles');
    expect(styles.length).toBe(1);

    document.querySelectorAll('[data-testid="cali-clipboard-toast"]').forEach(el => el.remove());
  });

  it('debe ser SSR-safe: retornar función no-op si no hay document', () => {
    const originalDocument = globalThis.document;
    (globalThis as { document?: Document }).document = undefined;

    try {
      const dismiss = showClipboardConfirmation('test');
      expect(typeof dismiss).toBe('function');
      // No debe lanzar al invocarla
      expect(() => dismiss()).not.toThrow();
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
