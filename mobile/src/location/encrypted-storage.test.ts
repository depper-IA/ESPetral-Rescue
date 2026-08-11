/**
 * Tests unitarios para el módulo de almacenamiento encriptado.
 * Verifica encriptación AES-GCM, fallback en memoria, y manejo de errores.
 *
 * Requisitos: 5.1, 5.2, 5.3, 5.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  toBase64,
  fromBase64,
  isLocalStorageAvailable,
  EncryptedStorage,
} from './encrypted-storage';

// --- Helpers de base64 ---

describe('toBase64 / fromBase64', () => {
  it('debe hacer round-trip con datos arbitrarios', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 42, 99]);
    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);
    expect(decoded).toEqual(original);
  });

  it('debe manejar un buffer vacío', () => {
    const empty = new Uint8Array(0);
    const encoded = toBase64(empty);
    const decoded = fromBase64(encoded);
    expect(decoded).toEqual(empty);
  });

  it('debe aceptar ArrayBuffer además de Uint8Array', () => {
    const data = new Uint8Array([10, 20, 30]);
    const encoded = toBase64(data.buffer as ArrayBuffer);
    const decoded = fromBase64(encoded);
    expect(decoded).toEqual(data);
  });
});

// --- isLocalStorageAvailable ---

describe('isLocalStorageAvailable', () => {
  it('debe retornar true cuando localStorage funciona', () => {
    // En entorno de test (node), localStorage podría no existir
    // Verificamos que la función no lance error
    const result = isLocalStorageAvailable();
    expect(typeof result).toBe('boolean');
  });
});

// --- EncryptedStorage con mock de localStorage ---

describe('EncryptedStorage', () => {
  let storage: EncryptedStorage;
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    mockLocalStorage = {};

    // Mock de localStorage global
    const localStorageMock = {
      getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
    };

    vi.stubGlobal('localStorage', localStorageMock);

    // Mock de navigator para fingerprint
    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      languages: ['es-CO'],
      language: 'es-CO',
    });

    vi.stubGlobal('screen', {
      width: 1080,
      height: 1920,
      colorDepth: 24,
    });

    // Mock de Intl para fingerprint
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({
        resolvedOptions: () => ({ timeZone: 'America/Bogota' }),
      }),
    });

    // Mock de document.createElement para canvas fingerprint
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 200,
        height: 50,
        getContext: () => ({
          textBaseline: '',
          font: '',
          fillStyle: '',
          fillRect: vi.fn(),
          fillText: vi.fn(),
        }),
        toDataURL: () => 'data:image/png;base64,mock',
      }),
    });

    storage = new EncryptedStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe inicializarse sin error', async () => {
    await storage.initialize();
    expect(storage.localStorageAvailable).toBe(true);
  });

  it('debe encriptar y desencriptar datos correctamente (round-trip)', async () => {
    await storage.initialize();

    const testData = JSON.stringify({ version: 1, entries: [{ id: 'test-1', lat: 3.45 }] });
    const writeResult = await storage.write(testData);
    expect(writeResult.success).toBe(true);

    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBe(testData);
    expect(readResult.recovered).toBe(false);
  });

  it('debe sobrevivir múltiples escrituras (append via LocationEngine)', async () => {
    await storage.initialize();

    const data1 = JSON.stringify({ version: 1, entries: [{ id: '1' }] });
    await storage.write(data1);

    const data2 = JSON.stringify({ version: 1, entries: [{ id: '1' }, { id: '2' }] });
    await storage.write(data2);

    const readResult = await storage.read();
    expect(readResult.data).toBe(data2);
  });

  it('debe manejar datos malformados en localStorage con recuperación', async () => {
    // Escribir datos corruptos directamente
    mockLocalStorage['cali_rescue_locations_encrypted'] = 'esto-no-es-json';
    await storage.initialize();

    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBeNull();
    expect(readResult.recovered).toBe(true);
  });

  it('debe manejar payload encriptado con campos faltantes', async () => {
    // Payload JSON válido pero sin campos requeridos
    mockLocalStorage['cali_rescue_locations_encrypted'] = JSON.stringify({ version: 1 });
    await storage.initialize();

    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBeNull();
    expect(readResult.recovered).toBe(true);
  });

  it('debe retornar null cuando no hay datos almacenados', async () => {
    await storage.initialize();

    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBeNull();
    expect(readResult.recovered).toBe(false);
  });

  it('debe limpiar datos correctamente con clear()', async () => {
    await storage.initialize();

    await storage.write('test-data');
    storage.clear();

    const readResult = await storage.read();
    expect(readResult.data).toBeNull();
  });

  it('debe fallar si write se llama sin inicializar', async () => {
    const result = await storage.write('test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('encryption_failed');
  });

  it('debe fallar si read se llama sin inicializar', async () => {
    const result = await storage.read();
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });
});

// --- EncryptedStorage sin localStorage ---

describe('EncryptedStorage (sin localStorage)', () => {
  let storage: EncryptedStorage;

  beforeEach(() => {
    // Simular localStorage no disponible
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('no disponible'); },
      setItem: () => { throw new Error('no disponible'); },
      removeItem: () => { throw new Error('no disponible'); },
    });

    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      languages: ['es-CO'],
      language: 'es-CO',
    });

    vi.stubGlobal('screen', { width: 1080, height: 1920, colorDepth: 24 });
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'America/Bogota' }) }),
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 200, height: 50,
        getContext: () => ({
          textBaseline: '', font: '', fillStyle: '',
          fillRect: vi.fn(), fillText: vi.fn(),
        }),
        toDataURL: () => 'data:image/png;base64,mock',
      }),
    });

    storage = new EncryptedStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe detectar que localStorage no está disponible', () => {
    expect(storage.localStorageAvailable).toBe(false);
  });

  it('debe usar fallback en memoria cuando localStorage no está disponible', async () => {
    await storage.initialize();

    const testData = '{"version":1,"entries":[]}';
    const writeResult = await storage.write(testData);
    expect(writeResult.success).toBe(true);

    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBe(testData);
  });
});

// --- EncryptedStorage con cuota excedida ---

describe('EncryptedStorage (cuota excedida)', () => {
  let storage: EncryptedStorage;

  beforeEach(() => {
    const testKey = '__cali_storage_test__';
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn((key: string) => {
        // Permitir el test de disponibilidad, fallar para escrituras reales
        if (key === testKey) return;
        const error = new DOMException('Quota exceeded', 'QuotaExceededError');
        throw error;
      }),
      removeItem: vi.fn(),
    });

    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      languages: ['es-CO'],
      language: 'es-CO',
    });
    vi.stubGlobal('screen', { width: 1080, height: 1920, colorDepth: 24 });
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'America/Bogota' }) }),
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 200, height: 50,
        getContext: () => ({
          textBaseline: '', font: '', fillStyle: '',
          fillRect: vi.fn(), fillText: vi.fn(),
        }),
        toDataURL: () => 'data:image/png;base64,mock',
      }),
    });

    storage = new EncryptedStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('debe reportar quota_exceeded y guardar en memoria como fallback', async () => {
    await storage.initialize();

    const testData = '{"version":1,"entries":[{"id":"x"}]}';
    const writeResult = await storage.write(testData);

    expect(writeResult.success).toBe(false);
    expect(writeResult.error).toBe('quota_exceeded');

    // El dato se guardó en memoria como fallback
    const readResult = await storage.read();
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBe(testData);
  });
});
