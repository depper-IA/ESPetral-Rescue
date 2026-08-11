/**
 * Motor de ubicación con persistencia encriptada.
 * Gestiona entradas de ubicación GPS con almacenamiento local encriptado
 * y fallback en memoria cuando localStorage no está disponible.
 *
 * Requisitos: 5.1, 5.2, 5.3, 5.5, 2.1
 */

import { EncryptedStorage, type StorageResult } from './encrypted-storage';

/**
 * Entrada de ubicación GPS con metadatos.
 */
export interface LocationEntry {
  id: string;               // UUID v4
  timestamp: string;        // ISO 8601
  lat: number;
  lon: number;
  accuracy: number;         // metros
  note: string;
  synced: boolean;          // true si el backend confirmó recepción
}

/** Estructura serializada para almacenamiento */
interface StoredLocations {
  version: 1;
  entries: LocationEntry[];
}

/** Estado del motor de ubicación */
export interface LocationEngineStatus {
  initialized: boolean;
  localStorageAvailable: boolean;
  entryCount: number;
  lastPersistError: string | null;
}

/**
 * Serializa las entradas de ubicación a JSON.
 * Función pura exportada para pruebas.
 */
export function serializeEntries(entries: LocationEntry[]): string {
  const stored: StoredLocations = { version: 1, entries };
  return JSON.stringify(stored);
}

/**
 * Deserializa entradas de ubicación desde JSON.
 * Función pura exportada para pruebas.
 * Retorna null si los datos son malformados.
 */
export function deserializeEntries(json: string): LocationEntry[] | null {
  try {
    const parsed = JSON.parse(json);

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }

    // Validar que cada entrada tiene los campos requeridos
    for (const entry of parsed.entries) {
      if (
        typeof entry.id !== 'string' ||
        typeof entry.timestamp !== 'string' ||
        typeof entry.lat !== 'number' ||
        typeof entry.lon !== 'number' ||
        typeof entry.accuracy !== 'number' ||
        typeof entry.note !== 'string' ||
        typeof entry.synced !== 'boolean'
      ) {
        return null;
      }
    }

    return parsed.entries as LocationEntry[];
  } catch {
    return null;
  }
}

/**
 * Ordena entradas en orden cronológico inverso (más reciente primero).
 * Función pura exportada para pruebas.
 */
export function sortEntriesReverseChronological(entries: LocationEntry[]): LocationEntry[] {
  return [...entries].sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeB - timeA;
  });
}

/**
 * Genera un UUID v4 usando crypto.randomUUID o fallback.
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback para navegadores sin randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Evento emitido por el motor de ubicación */
export type LocationEngineEvent =
  | { type: 'entry_added'; entry: LocationEntry }
  | { type: 'persist_error'; error: string }
  | { type: 'data_recovered'; message: string }
  | { type: 'storage_unavailable' };

type EventListener = (event: LocationEngineEvent) => void;

/**
 * Motor principal de gestión de ubicaciones.
 * Coordina la persistencia encriptada y el estado en memoria.
 */
export class LocationEngine {
  private storage: EncryptedStorage;
  private entries: LocationEntry[] = [];
  private listeners: EventListener[] = [];
  private _initialized = false;
  private _lastPersistError: string | null = null;

  constructor(storage?: EncryptedStorage) {
    this.storage = storage || new EncryptedStorage();
  }

  /** Estado actual del motor */
  get status(): LocationEngineStatus {
    return {
      initialized: this._initialized,
      localStorageAvailable: this.storage.localStorageAvailable,
      entryCount: this.entries.length,
      lastPersistError: this._lastPersistError,
    };
  }

  /**
   * Inicializa el motor: prepara encriptación y carga datos existentes.
   * Emite evento de recuperación si se descartaron datos corruptos.
   * Emite evento de storage_unavailable si localStorage no está disponible.
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();

    if (!this.storage.localStorageAvailable) {
      this.emit({ type: 'storage_unavailable' });
    }

    const result = await this.storage.read();

    if (result.recovered) {
      this.emit({ type: 'data_recovered', message: result.error || 'Registros previos no pudieron ser recuperados' });
    }

    if (result.data) {
      const parsed = deserializeEntries(result.data);
      if (parsed) {
        this.entries = parsed;
      } else {
        // Datos deserializados inválidos — comenzar fresco
        this.emit({ type: 'data_recovered', message: 'Datos de ubicación malformados descartados' });
      }
    }

    this._initialized = true;
  }

  /**
   * Agrega una nueva entrada de ubicación.
   * Persiste dentro de 100ms de creación (append sin sobrescribir).
   */
  async addEntry(lat: number, lon: number, accuracy: number, note: string): Promise<LocationEntry> {
    const entry: LocationEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      lat,
      lon,
      accuracy,
      note,
      synced: false,
    };

    // Append sin sobrescribir
    this.entries.push(entry);
    this.emit({ type: 'entry_added', entry });

    // Persistir inmediatamente (objetivo: <100ms)
    await this.persist();

    return entry;
  }

  /**
   * Retorna todas las entradas en orden cronológico inverso.
   */
  getEntries(): LocationEntry[] {
    return sortEntriesReverseChronological(this.entries);
  }

  /**
   * Retorna todas las entradas sin ordenar (orden de inserción).
   */
  getRawEntries(): LocationEntry[] {
    return [...this.entries];
  }

  /**
   * Retorna entradas no sincronizadas en orden cronológico.
   */
  getUnsyncedEntries(): LocationEntry[] {
    return this.entries
      .filter(e => !e.synced)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Marca entradas como sincronizadas por sus IDs.
   */
  async markSynced(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    for (const entry of this.entries) {
      if (idSet.has(entry.id)) {
        entry.synced = true;
      }
    }
    await this.persist();
  }

  /**
   * Limpia todas las entradas (localStorage + memoria).
   */
  clear(): void {
    this.entries = [];
    this.storage.clear();
    this._lastPersistError = null;
  }

  /**
   * Registra un listener de eventos.
   */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Persiste el estado actual al almacenamiento encriptado.
   */
  private async persist(): Promise<StorageResult> {
    const serialized = serializeEntries(this.entries);
    const result = await this.storage.write(serialized);

    if (!result.success) {
      this._lastPersistError = result.message || 'Error desconocido';
      this.emit({ type: 'persist_error', error: this._lastPersistError });
    } else {
      this._lastPersistError = null;
    }

    return result;
  }

  /** Emite un evento a todos los listeners */
  private emit(event: LocationEngineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
