/**
 * Módulo de almacenamiento encriptado para entradas de ubicación.
 * Utiliza AES-GCM via Web Crypto API con clave derivada de huella del dispositivo.
 *
 * Maneja: fallas de escritura, datos malformados, cuota excedida,
 * localStorage no disponible, y fallback en memoria.
 *
 * Requisitos: 5.1, 5.2, 5.3, 5.5
 */

const STORAGE_KEY = 'cali_rescue_locations_encrypted';
const STORAGE_VERSION = 1;

/** Estructura almacenada en localStorage (encriptada) */
interface EncryptedPayload {
  version: number;
  iv: string;       // Base64 del IV
  ciphertext: string; // Base64 del texto cifrado
}

/**
 * Genera una huella del dispositivo estable usando canvas + userAgent.
 * No es criptográficamente perfecta pero provee entropía suficiente
 * para derivar una clave local de encriptación.
 */
export async function generateDeviceFingerprint(): Promise<string> {
  const components: string[] = [];

  // UserAgent como base
  components.push(navigator.userAgent);

  // Características de pantalla
  components.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);

  // Zona horaria
  components.push(Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Canvas fingerprint
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('CALI-Rescue-FP', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('CALI-Rescue-FP', 4, 17);
      components.push(canvas.toDataURL());
    }
  } catch {
    // Canvas no disponible — seguimos sin él
    components.push('no-canvas');
  }

  // Idiomas del navegador
  components.push((navigator.languages || [navigator.language]).join(','));

  return components.join('|||');
}

/**
 * Deriva una clave AES-GCM a partir de la huella del dispositivo
 * usando PBKDF2 con un salt fijo (la clave es local, no cross-device).
 */
export async function deriveEncryptionKey(fingerprint: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(fingerprint),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  // Salt fijo — aceptable porque la clave es local al dispositivo
  const salt = encoder.encode('cali-rescue-v1-salt');

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encripta datos JSON usando AES-GCM.
 */
export async function encrypt(data: string, key: CryptoKey): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data),
  );

  return { iv, ciphertext };
}

/**
 * Desencripta datos usando AES-GCM.
 */
export async function decrypt(ciphertext: ArrayBuffer, iv: Uint8Array, key: CryptoKey): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Convierte ArrayBuffer/Uint8Array a base64.
 */
export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convierte base64 a Uint8Array.
 */
export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Resultado de una operación de almacenamiento */
export interface StorageResult {
  success: boolean;
  error?: 'quota_exceeded' | 'storage_unavailable' | 'encryption_failed' | 'unknown';
  message?: string;
}

/** Resultado de una operación de lectura */
export interface ReadResult<T> {
  success: boolean;
  data: T | null;
  recovered: boolean; // true si se descartaron datos corruptos
  error?: string;
}

/**
 * Verifica si localStorage está disponible.
 */
export function isLocalStorageAvailable(): boolean {
  try {
    const testKey = '__cali_storage_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clase de almacenamiento encriptado con fallback en memoria.
 */
export class EncryptedStorage {
  private key: CryptoKey | null = null;
  private memoryFallback: string | null = null;
  private _localStorageAvailable: boolean;

  constructor() {
    this._localStorageAvailable = isLocalStorageAvailable();
  }

  /** Indica si localStorage está disponible */
  get localStorageAvailable(): boolean {
    return this._localStorageAvailable;
  }

  /**
   * Inicializa la clave de encriptación.
   * Debe llamarse antes de read/write.
   */
  async initialize(): Promise<void> {
    const fingerprint = await generateDeviceFingerprint();
    this.key = await deriveEncryptionKey(fingerprint);
  }

  /**
   * Escribe datos encriptados en localStorage.
   * Si localStorage no está disponible, almacena en memoria.
   */
  async write(data: string): Promise<StorageResult> {
    if (!this.key) {
      return { success: false, error: 'encryption_failed', message: 'Clave no inicializada' };
    }

    try {
      const { iv, ciphertext } = await encrypt(data, this.key);
      const payload: EncryptedPayload = {
        version: STORAGE_VERSION,
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
      };

      const serialized = JSON.stringify(payload);

      if (!this._localStorageAvailable) {
        this.memoryFallback = serialized;
        return { success: true };
      }

      try {
        localStorage.setItem(STORAGE_KEY, serialized);
        return { success: true };
      } catch (e: unknown) {
        // Fallback a memoria en caso de error de escritura
        this.memoryFallback = serialized;

        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          return { success: false, error: 'quota_exceeded', message: 'Cuota de almacenamiento excedida' };
        }
        return { success: false, error: 'storage_unavailable', message: 'Error al escribir en localStorage' };
      }
    } catch {
      return { success: false, error: 'encryption_failed', message: 'Error al encriptar datos' };
    }
  }

  /**
   * Lee y desencripta datos de localStorage.
   * Si no hay datos o están corruptos, retorna null con flag de recuperación.
   */
  async read(): Promise<ReadResult<string>> {
    if (!this.key) {
      return { success: false, data: null, recovered: false, error: 'Clave no inicializada' };
    }

    // Intentar leer de localStorage primero, luego fallback en memoria
    let raw: string | null = null;

    if (this._localStorageAvailable) {
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch {
        // localStorage falló al leer — intentar memoria
      }
    }

    if (!raw && this.memoryFallback) {
      raw = this.memoryFallback;
    }

    if (!raw) {
      return { success: true, data: null, recovered: false };
    }

    try {
      const payload: EncryptedPayload = JSON.parse(raw);

      if (!payload.version || !payload.iv || !payload.ciphertext) {
        // Datos malformados — descartar
        this.clearCorrupted();
        return { success: true, data: null, recovered: true, error: 'Datos malformados descartados' };
      }

      const iv = fromBase64(payload.iv);
      const ciphertext = fromBase64(payload.ciphertext);
      const decrypted = await decrypt(ciphertext.buffer as ArrayBuffer, iv, this.key);

      return { success: true, data: decrypted, recovered: false };
    } catch {
      // Datos corruptos o clave cambiada — descartar e iniciar fresco
      this.clearCorrupted();
      return { success: true, data: null, recovered: true, error: 'Registros previos no pudieron ser recuperados' };
    }
  }

  /**
   * Elimina todos los datos almacenados.
   */
  clear(): void {
    this.memoryFallback = null;
    if (this._localStorageAvailable) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignorar errores al limpiar
      }
    }
  }

  /** Limpia datos corruptos de localStorage */
  private clearCorrupted(): void {
    this.memoryFallback = null;
    if (this._localStorageAvailable) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignorar
      }
    }
  }
}
