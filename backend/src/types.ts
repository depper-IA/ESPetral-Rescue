/**
 * ESPetral Rescue — Core TypeScript Interfaces
 *
 * Defines message schemas and data models for the backend server,
 * MQTT broker communication, and WebSocket relay.
 */

// --- MQTT Message Schemas ---

/** CSI telemetry message published by ESP32 nodes on `cali/zone/{zone_id}/csi` */
export interface CsiTelemetryMessage {
  /** Zone identifier (1–64 characters) */
  zone_id: string;
  /** ISO 8601 timestamp of the reading */
  timestamp: string;
  /** Motion probability derived from subcarrier variance (0.0–1.0) */
  motion_probability: number;
  /** Unique node identifier (1–64 characters) */
  node_id: string;
}

/** Probability update published on `cali/zone/{zone_id}/probability` */
export interface ProbabilityUpdate {
  /** Zone identifier */
  zone_id: string;
  /** Composite probability score (0–100 integer) */
  probability: number;
  /** Per-source contributions (null if source is stale/unavailable) */
  sources: {
    csi: number | null;
    acoustic: number | null;
    gps: number | null;
  };
  /** ISO 8601 timestamp of computation */
  timestamp: string;
}

/** Priority alert emitted when composite score exceeds threshold */
export interface PriorityAlert {
  zone_id: string;
  probability: number;
  triggered_at: string;
  contributing_factors: string[];
}

// --- Location Sync Protocol ---

/** A single location entry logged by a mobile device */
export interface LocationEntry {
  /** UUID v4 generated on the mobile device */
  id: string;
  /** ISO 8601 timestamp of capture */
  timestamp: string;
  /** Latitude in decimal degrees */
  lat: number;
  /** Longitude in decimal degrees */
  lon: number;
  /** GPS accuracy in meters */
  accuracy: number;
  /** User-provided note */
  note: string;
  /** Whether the backend has acknowledged this entry */
  synced: boolean;
}

/** Batch of location entries sent from mobile app to backend (max 50 per batch) */
export interface LocationSyncBatch {
  entries: LocationEntry[];
  device_token: string;
}

/** Backend acknowledgment for a location sync batch */
export interface LocationSyncAck {
  acknowledged_ids: string[];
  errors: { id: string; reason: string }[];
}

// --- Zone Management ---

/** Zone definition representing a search area */
export interface Zone {
  /** Unique zone identifier */
  id: string;
  /** Human-readable zone name */
  name: string;
  /** Center latitude in decimal degrees */
  center_lat: number;
  /** Center longitude in decimal degrees */
  center_lon: number;
  /** Search radius in meters (default 50) */
  radius_m: number;
  /** Node IDs assigned to this zone */
  nodes: string[];
  /** Latest composite probability score (0–100) */
  last_probability: number;
  /** ISO 8601 timestamp of last probability update */
  last_update: string;
}

/** Zone score as stored in the probability_scores table */
export interface ZoneScore {
  zone_id: string;
  score: number;
  csi_contribution: number | null;
  acoustic_contribution: number | null;
  gps_contribution: number | null;
  computed_at: string;
}

// --- Node Status ---

/** ESP32 node connection status */
export interface NodeStatus {
  node_id: string;
  zone_id: string;
  online: boolean;
  last_seen: string;
}

// --- Dashboard State ---

/** Color classification for zone probability display */
export type ZoneColor = 'green' | 'yellow' | 'red' | 'grey';

/** Maps a probability value to a display color */
export function probabilityToColor(probability: number | null): ZoneColor {
  if (probability === null) return 'grey';
  if (probability < 0.3) return 'green';
  if (probability < 0.6) return 'yellow';
  return 'red';
}

// --- Acoustic Reports ---

/** Acoustic knock detection report from mobile app */
export interface AcousticReport {
  id: string;
  zone_id: string;
  device_token: string;
  peak_count: number;
  mean_interval_ms: number;
  confidence: number;
  lat: number | null;
  lon: number | null;
  reported_at: string;
}

// --- Device Authentication ---

export type DeviceType = 'esp32' | 'mobile';

/** Device token record for authentication */
export interface DeviceToken {
  token: string;
  device_type: DeviceType;
  label: string | null;
  zone_id: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
}
