/**
 * Tests de integración del componente App.
 * Verifica que las 5 secciones principales se renderizan correctamente
 * y que la inicialización no falla con los mocks apropiados.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

/** Wrapper sin StrictMode para evitar doble render en tests (React 19 + RTL lo activan por default). */
function NoStrictMode({ children }: { children: React.ReactNode }): React.ReactNode {
  return <>{children}</>;
}

// Cleanup automático entre tests — RTL no lo activa por default en vitest.
afterEach(() => cleanup());

// --- Mocks de APIs del navegador ---

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.(new Event('close'));
  }
  // Helper para simular apertura
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];

  // localStorage mock básico (EncryptedStorage lo usa)
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

  // crypto.randomUUID mock si no está
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        ...globalThis.crypto,
        randomUUID: () => 'mock-uuid-' + Math.random().toString(36).slice(2),
      },
      writable: true,
      configurable: true,
    });
  }

  // WebSocket mock
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  // navigator.geolocation mock
  Object.defineProperty(navigator, 'geolocation', {
    value: {
      getCurrentPosition: vi.fn((success) => {
        // Simular respuesta inmediata
        setTimeout(() => {
          success({
            coords: { latitude: 3.4516, longitude: -76.532, accuracy: 10 },
          });
        }, 0);
      }),
    },
    writable: true,
    configurable: true,
  });

  // navigator.mediaDevices.getUserMedia mock
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockRejectedValue(
        new Error('Micrófono no disponible en test'),
      ),
    },
    writable: true,
    configurable: true,
  });

  // matchMedia para ClearLogDialog y otros
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
    writable: true,
    configurable: true,
  });

  // HTMLDialogElement mock (jsdom no implementa <dialog> nativo)
  if (typeof window !== 'undefined' && !window.HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', {
      value: function () {
        this.setAttribute('open', '');
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window.HTMLDialogElement.prototype, 'close', {
      value: function () {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      },
      writable: true,
      configurable: true,
    });
  }
});

describe('App', () => {
  it('debe renderizar el título y el subtítulo del header', () => {
    render(<App />, { wrapper: NoStrictMode });
    expect(screen.getByRole('heading', { name: /ESPetral Rescue/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Buscador táctico de presencia humana y rescate/i)).toBeInTheDocument();
  });

  it('debe renderizar el indicador de estado de sync', () => {
    render(<App />, { wrapper: NoStrictMode });
    // El indicador muestra estado inicial 'disconnected' antes de conectar
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('debe renderizar la navegación táctica unificada y el buscador RADAR', () => {
    render(<App />, { wrapper: NoStrictMode });
    expect(screen.getByRole('heading', { name: /BUSCADOR TÁCTICO RADAR/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /RADAR/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GOLPES/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MAPA/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GPS/i })).toBeInTheDocument();
  });

  it('debe mostrar estado vacío en el mapa cuando no hay entradas', () => {
    render(<App />, { wrapper: NoStrictMode });
    fireEvent.click(screen.getByRole('button', { name: /MAPA/i }));
    expect(screen.getByText(/Sin ubicaciones registradas aún/i)).toBeInTheDocument();
  });

  it('debe deshabilitar botones de acción cuando no hay entradas', () => {
    render(<App />, { wrapper: NoStrictMode });
    fireEvent.click(screen.getByRole('button', { name: /GPS/i }));
    const shareButton = screen.getByRole('button', { name: /Compartir la última ubicación/i });
    const clearButton = screen.getByRole('button', { name: /Limpiar todo el registro/i });
    expect(shareButton).toBeDisabled();
    expect(clearButton).toBeDisabled();
  });

  it('debe renderizar input de nota con label accesible', () => {
    render(<App />, { wrapper: NoStrictMode });
    fireEvent.click(screen.getByRole('button', { name: /GPS/i }));
    const noteInput = screen.getByLabelText(/Nota para la ubicación a registrar/i);
    expect(noteInput).toBeInTheDocument();
    expect(noteInput.tagName).toBe('INPUT');
  });

  it('debe intentar conectar al backend vía WebSocket en mount', () => {
    render(<App />, { wrapper: NoStrictMode });
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
  });

  it('debe mostrar el estado del detector de patrones de golpe integrado', () => {
    render(<App />, { wrapper: NoStrictMode });
    fireEvent.click(screen.getByRole('button', { name: /GOLPES/i }));
    // El detector de patrones está ahora integrado; debe verse su estado dentro de
    // su contenedor .cali-knock-status para no chocar con la meta del audio.
    const knockStatus = document.querySelector('.cali-knock-status');
    expect(knockStatus).toBeInTheDocument();
    expect(knockStatus).toHaveTextContent(/Picos en ventana/i);
    expect(knockStatus).toHaveTextContent(/Estado: Detenido/i);
  });
});
