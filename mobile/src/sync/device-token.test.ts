/**
 * ESPetral Rescue — Tests para el identificador local de dispositivo
 *
 * Requisitos: 13.1 (device_token requerido por el protocolo de sync)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateDeviceToken } from './device-token';

describe('getOrCreateDeviceToken', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
      writable: true,
      configurable: true,
    });

    if (!globalThis.crypto?.randomUUID) {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...globalThis.crypto, randomUUID: () => 'mock-uuid-1234' },
        writable: true,
        configurable: true,
      });
    }
  });

  it('genera un token no vacío en la primera llamada', () => {
    const token = getOrCreateDeviceToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('retorna el mismo token en llamadas subsecuentes (persistido)', () => {
    const first = getOrCreateDeviceToken();
    const second = getOrCreateDeviceToken();
    expect(second).toBe(first);
  });

  it('persiste el token en localStorage', () => {
    const token = getOrCreateDeviceToken();
    expect(window.localStorage.getItem('cali_rescue_device_token')).toBe(token);
  });

  it('genera un token nuevo si localStorage no está disponible', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => { throw new Error('no disponible'); },
        setItem: () => { throw new Error('no disponible'); },
      },
      writable: true,
      configurable: true,
    });

    expect(() => getOrCreateDeviceToken()).not.toThrow();
    expect(typeof getOrCreateDeviceToken()).toBe('string');
  });
});
