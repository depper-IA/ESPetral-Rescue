/**
 * CALI Rescue System — Identificador local de dispositivo (device_token)
 *
 * Usado para asociar entradas de ubicación y reportes acústicos sincronizados
 * con el backend. NO es un token de autenticación — es solo un identificador
 * local persistido en localStorage para deduplicación básica del lado backend.
 *
 * Requisitos: 13.1
 */
import { generateId } from '../location/location-engine';

const DEVICE_TOKEN_KEY = 'cali_rescue_device_token';

/**
 * Retorna el device_token persistido, generando uno nuevo la primera vez.
 * Si localStorage no está disponible, genera uno nuevo en cada llamada
 * (aceptable: el device_token solo se usa para deduplicación básica, no
 * para autenticación).
 */
export function getOrCreateDeviceToken(): string {
  try {
    const existing = localStorage.getItem(DEVICE_TOKEN_KEY);
    if (existing) return existing;

    const generated = generateId();
    localStorage.setItem(DEVICE_TOKEN_KEY, generated);
    return generated;
  } catch {
    return generateId();
  }
}
