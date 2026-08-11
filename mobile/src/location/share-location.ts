/**
 * Módulo de compartir ubicación via Web Share API.
 * Formatea entradas de ubicación como texto y las comparte
 * usando la API nativa del navegador, con fallback a clipboard.
 *
 * Requisitos: 2.1, 2.2, 2.3, 2.4
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
    '📍 Ubicación registrada',
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
