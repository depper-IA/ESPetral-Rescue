/**
 * CALI Rescue System — Motor de sincronización WebSocket
 *
 * Conecta la app móvil al relay WebSocket del backend (puerto 9002).
 * Protocolo JSON (no MQTT directo): recibe alertas CSI de zonas,
 * gestiona reconexión con reintentos, y mantiene un buffer acotado de alertas.
 *
 * Requisitos: 8.1, 8.2, 8.3, 8.4, 8.5
 */

// --- Tipos ---

/** Alerta de zona recibida del backend */
export interface ZoneAlert {
  /** Identificador de la zona */
  zone_id: string;
  /** Probabilidad de movimiento (0.0–1.0) */
  motion_probability: number;
  /** Timestamp ISO 8601 de la lectura */
  timestamp: string;
}

/** Mensaje entrante del relay WebSocket */
export interface RelayMessage {
  type: string;
  payload: unknown;
}

/** Estado de conexión del motor de sincronización */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Opciones de configuración del SyncEngine */
export interface SyncEngineOptions {
  /** URL del servidor WebSocket relay (ej: ws://192.168.1.10:9002) */
  url: string;
  /** Timeout de conexión en ms (default: 5000) */
  connectionTimeout?: number;
  /** Intervalo de reintento en ms (default: 5000) */
  retryInterval?: number;
  /** Máximo de reintentos antes de mostrar indicador offline persistente (default: 10) */
  maxRetries?: number;
  /** Máximo de alertas retenidas en el buffer (default: 50) */
  maxAlerts?: number;
  /** Tiempo máximo para remover indicador offline al reconectar en ms (default: 2000) */
  reconnectGrace?: number;
}

/** Listener para eventos del SyncEngine */
export interface SyncEngineListener {
  /** Invocado cuando cambia el estado de conexión */
  onConnectionStateChange?: (state: ConnectionState) => void;
  /** Invocado cuando se recibe una alerta CSI de zona */
  onAlert?: (alert: ZoneAlert) => void;
  /** Invocado cuando se activa el indicador offline persistente (10 reintentos agotados) */
  onPersistentOffline?: (offline: boolean) => void;
}

// --- Constantes por defecto ---

const DEFAULT_CONNECTION_TIMEOUT = 5000;
const DEFAULT_RETRY_INTERVAL = 5000;
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_MAX_ALERTS = 50;
const DEFAULT_RECONNECT_GRACE = 2000;

/** Patrón para identificar mensajes CSI de zonas: cali/zone/{id}/csi */
const CSI_TOPIC_PATTERN = /^cali\/zone\/[^/]+\/csi$/;

// --- Clase SyncEngine ---

export class SyncEngine {
  private readonly url: string;
  private readonly connectionTimeout: number;
  private readonly retryInterval: number;
  private readonly maxRetries: number;
  private readonly maxAlerts: number;
  private readonly reconnectGrace: number;

  private socket: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentOffline = false;
  private alerts: ZoneAlert[] = [];
  private listener: SyncEngineListener = {};
  private intentionalClose = false;

  constructor(options: SyncEngineOptions) {
    this.url = options.url;
    this.connectionTimeout = options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    this.retryInterval = options.retryInterval ?? DEFAULT_RETRY_INTERVAL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxAlerts = options.maxAlerts ?? DEFAULT_MAX_ALERTS;
    this.reconnectGrace = options.reconnectGrace ?? DEFAULT_RECONNECT_GRACE;
  }

  // --- API pública ---

  /** Registra un listener para eventos del engine */
  setListener(listener: SyncEngineListener): void {
    this.listener = listener;
  }

  /** Inicia la conexión al backend */
  connect(): void {
    if (this.connectionState === 'connecting' || this.connectionState === 'connected') {
      return;
    }
    this.intentionalClose = false;
    this.attemptConnection();
  }

  /** Cierra la conexión y detiene reintentos */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    this.closeSocket();
    this.setConnectionState('disconnected');
  }

  /** Retorna el estado de conexión actual */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /** Retorna si el indicador offline persistente está activo */
  isPersistentOffline(): boolean {
    return this.persistentOffline;
  }

  /** Retorna el buffer de alertas (más recientes primero) */
  getAlerts(): readonly ZoneAlert[] {
    return this.alerts;
  }

  /** Retorna la cantidad de reintentos realizados */
  getRetryCount(): number {
    return this.retryCount;
  }

  /** Envía un mensaje al relay (para sync de ubicaciones, reportes acústicos, etc.) */
  send(type: string, payload: unknown): boolean {
    if (!this.socket || this.connectionState !== 'connected') {
      return false;
    }
    try {
      const message = JSON.stringify({ type, payload });
      this.socket.send(message);
      return true;
    } catch {
      return false;
    }
  }

  // --- Conexión ---

  private attemptConnection(): void {
    this.setConnectionState('connecting');

    try {
      this.socket = new WebSocket(this.url);
    } catch {
      // Error al crear el socket (URL inválida, etc.)
      this.handleConnectionFailure();
      return;
    }

    // Timeout de conexión: 5 segundos
    this.timeoutTimer = setTimeout(() => {
      if (this.connectionState === 'connecting') {
        this.closeSocket();
        this.handleConnectionFailure();
      }
    }, this.connectionTimeout);

    this.socket.onopen = () => {
      this.clearTimeout();
      this.retryCount = 0;
      this.setConnectionState('connected');

      // Remover indicador offline persistente dentro del tiempo de gracia
      if (this.persistentOffline) {
        this.setPersistentOffline(false);
      }
    };

    this.socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    this.socket.onclose = () => {
      if (!this.intentionalClose) {
        this.setConnectionState('disconnected');
        this.scheduleRetry();
      }
    };

    this.socket.onerror = () => {
      // El evento error siempre precede a close en WebSocket
      // La lógica de reintento se maneja en onclose
    };
  }

  private handleConnectionFailure(): void {
    this.setConnectionState('disconnected');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.intentionalClose) return;

    this.retryCount++;

    if (this.retryCount >= this.maxRetries) {
      this.setPersistentOffline(true);
      // Seguimos intentando pero con indicador offline visible
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attemptConnection();
    }, this.retryInterval);
  }

  // --- Manejo de mensajes ---

  private handleMessage(data: unknown): void {
    let message: RelayMessage;

    try {
      const raw = typeof data === 'string' ? data : String(data);
      message = JSON.parse(raw) as RelayMessage;
    } catch {
      // Mensaje inválido, descartar silenciosamente
      return;
    }

    if (!message.type || typeof message.type !== 'string') return;

    // Solo procesamos mensajes CSI de zonas
    if (CSI_TOPIC_PATTERN.test(message.type)) {
      this.handleCsiMessage(message);
    }
  }

  private handleCsiMessage(message: RelayMessage): void {
    const payload = message.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return;

    const alert: ZoneAlert = {
      zone_id: typeof payload.zone_id === 'string'
        ? payload.zone_id
        : this.extractZoneIdFromTopic(message.type),
      motion_probability: typeof payload.motion_probability === 'number'
        ? payload.motion_probability
        : 0,
      timestamp: typeof payload.timestamp === 'string'
        ? payload.timestamp
        : new Date().toISOString(),
    };

    this.addAlert(alert);
    this.listener.onAlert?.(alert);
  }

  /** Extrae el zone_id del tópico: cali/zone/{zone_id}/csi */
  private extractZoneIdFromTopic(topic: string): string {
    const parts = topic.split('/');
    return parts[2] ?? 'unknown';
  }

  // --- Buffer de alertas (máximo 50, las más recientes) ---

  private addAlert(alert: ZoneAlert): void {
    // Insertar al inicio (más reciente primero)
    this.alerts.unshift(alert);

    // Recortar si excede el máximo
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(0, this.maxAlerts);
    }
  }

  // --- Gestión de estado ---

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.listener.onConnectionStateChange?.(state);
  }

  private setPersistentOffline(offline: boolean): void {
    if (this.persistentOffline === offline) return;
    this.persistentOffline = offline;
    this.listener.onPersistentOffline?.(offline);
  }

  // --- Limpieza ---

  private closeSocket(): void {
    if (this.socket) {
      // Remover handlers para evitar callbacks post-close
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close();
      } catch {
        // Ignorar errores al cerrar
      }
      this.socket = null;
    }
  }

  private clearTimeout(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearTimeout();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
