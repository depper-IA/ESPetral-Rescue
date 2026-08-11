/**
 * Módulo de compartir ubicación via Web Share API.
 * Formatea entradas de ubicación como texto y las comparte
 * usando la API nativa del navegador, con fallback a clipboard.
 *
 * Requisitos: 2.1, 2.2, 2.3, 2.4
 *
 * Nota sobre emojis: la regla del proyecto es "sin emojis en interfaces".
 * Este módulo NO usa emojis en el texto de compartir (Req 2.4 visualización).
 */

import type { LocationEntry } from './location-engine';

/** Resultado de la operación de compartir */
export interface ShareResult {
  success: boolean;
  method: 'share' | 'clipboard' | 'none';
  message: string;
}

/**
 * Formatea una LocationEntry como texto plano para compartir.
 * Orden: timestamp, precisión, nota, coordenadas, enlace Google Maps.
 *
 * Valida: Property 4 — Todos los campos en orden exacto.
 */
export function formatShareText(entry: LocationEntry): string {
  const date = new Date(entry.timestamp);
  const formattedDate = formatDate(date);
  const mapsLink = `https://maps.google.com/?q=${entry.lat},${entry.lon}`;

  return [
    'Ubicación registrada',
    `Fecha: ${formattedDate}`,
    `Precisión: ${entry.accuracy}m`,
    `Nota: ${entry.note}`,
    `Coordenadas: ${entry.lat}, ${entry.lon}`,
    `Mapa: ${mapsLink}`,
  ].join('\n');
}

/**
 * Formatea una fecha en formato legible: YYYY-MM-DD HH:mm:ss
 */
function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Verifica si la Web Share API está disponible en el navegador.
 */
export function isShareAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Verifica si la Clipboard API está disponible en el navegador.
 */
export function isClipboardAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function'
  );
}

/**
 * Comparte una LocationEntry usando Web Share API o fallback a clipboard.
 *
 * - Si no hay entrada (null/undefined), retorna un mensaje indicando que no hay nada que compartir.
 * - Si Web Share API está disponible, la invoca con el texto formateado.
 * - Si Web Share no está disponible, copia al portapapeles.
 * - Si ninguna API está disponible, retorna error.
 *
 * Requisitos: 2.1, 2.2, 2.3, 2.4
 */
export async function shareLocation(entry: LocationEntry | null | undefined): Promise<ShareResult> {
  // Caso: no hay entrada para compartir (Req 2.3)
  if (!entry) {
    return {
      success: false,
      method: 'none',
      message: 'No hay ubicación registrada para compartir',
    };
  }

  const text = formatShareText(entry);

  // Intentar Web Share API primero (Req 2.1)
  if (isShareAvailable()) {
    try {
      await navigator.share({ text });
      return {
        success: true,
        method: 'share',
        message: 'Ubicación compartida exitosamente',
      };
    } catch (error: unknown) {
      // Si el usuario canceló el diálogo de compartir, no es un error real
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          method: 'share',
          message: 'Compartir cancelado por el usuario',
        };
      }
      // Otros errores: intentar fallback a clipboard
    }
  }

  // Fallback: copiar al portapapeles (Req 2.2)
  if (isClipboardAvailable()) {
    try {
      await navigator.clipboard.writeText(text);
      return {
        success: true,
        method: 'clipboard',
        message: 'Copiado al portapapeles',
      };
    } catch {
      return {
        success: false,
        method: 'clipboard',
        message: 'No se pudo copiar al portapapeles',
      };
    }
  }

  return {
    success: false,
    method: 'none',
    message: 'Compartir no disponible en este dispositivo',
  };
}

// --- Confirmación visual post-clipboard (Req 2.4) ---

/**
 * ID del elemento <style> que contiene la animación del toast.
 * Se inyecta una sola vez por página.
 */
const TOAST_STYLE_ID = 'cali-clipboard-toast-styles';

/**
 * Muestra un toast DOM de confirmación por la duración especificada.
 *
 * Requisito 2.4: cuando se hace fallback a clipboard copy (porque Web Share
 * no está disponible), el usuario debe recibir confirmación visual durante
 * al menos 2 segundos. Esta función provee ese feedback.
 *
 * - Inserta un `<div role="status" aria-live="polite">` al final del body
 * - Se elimina automáticamente después de `durationMs` (default 2000)
 * - Retorna función de cancelación manual (útil en tests o si el componente
 *   se desmonta antes del cleanup)
 *
 * SSR-safe: si `document` no existe, retorna una función no-op.
 */
export function showClipboardConfirmation(
  message = 'Copiado al portapapeles',
  durationMs = 2000
): () => void {
  // SSR safety — no-op si no hay DOM
  if (typeof document === 'undefined') {
    return () => {};
  }

  // Inyectar keyframes de animación una sola vez
  if (!document.getElementById(TOAST_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = TOAST_STYLE_ID;
    style.textContent = `
      @keyframes cali-clipboard-toast-in {
        from { opacity: 0; transform: translate(-50%, 16px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }
      @keyframes cali-clipboard-toast-out {
        from { opacity: 1; transform: translate(-50%, 0); }
        to { opacity: 0; transform: translate(-50%, 8px); }
      }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('data-testid', 'cali-clipboard-toast');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(33, 37, 41, 0.92);
    color: #fff;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    z-index: 10000;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    animation: cali-clipboard-toast-in 200ms ease-out;
  `;

  document.body.appendChild(toast);

  const dismiss = (): void => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
    clearTimeout(timerId);
  };

  const timerId = setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, durationMs);

  return dismiss;
}
