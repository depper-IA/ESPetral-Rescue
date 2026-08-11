# Implementation Plan: Cali Rescue System

## Overview

Integrated search-and-rescue detection system combining acoustic detection, Wi-Fi CSI motion sensing (multi-target: ESP32-S3, ESP32-C6, or ESP32-C3), and GPS location logging. The implementation spans three tiers: a single-file mobile web app, a Node.js backend with MQTT broker, and ESP32 firmware. Tasks are ordered to build foundational infrastructure first, then layer detection capabilities, and finally wire everything together.

## Tasks

- [x] 1. Set up backend project structure and core interfaces
  - [x] 1.1 Initialize Node.js project with Express, Aedes MQTT broker, better-sqlite3, and ws dependencies
    - Create `backend/` directory with `package.json`, `tsconfig.json`
    - Install dependencies using **pnpm** (npm is PROHIBITED): `pnpm add express aedes better-sqlite3 ws mqtt` and dev deps `pnpm add -D typescript @types/node @types/express @types/better-sqlite3 @types/ws`
    - Define TypeScript interfaces for `CSITelemetry`, `ProbabilityUpdate`, `SyncBatch`, `SyncAck`, `ZoneScore`
    - _Requirements: 6.1, 6.3, 7.1_

  - [x] 1.2 Create SQLite database schema with SQLCipher encryption
    - Implement schema creation script with all tables: `zones`, `nodes`, `csi_readings`, `acoustic_reports`, `location_entries`, `probability_scores`
    - Add indexes for expiration queries
    - Implement 72h TTL auto-purge daemon (runs every 15 minutes)
    - _Requirements: 6.3, 11.1_

  - [x] 1.3 Implement MQTT broker with PSK authentication and topic validation
    - Configure Aedes broker on port 1883 (MQTT) and port 9001 (WebSocket)
    - Implement PSK-based authentication for CONNECT packets
    - Add message validation: reject payloads >1KB, validate JSON schema on `cali/zone/{zone_id}/csi`
    - Configure keep-alive at 60 seconds, disconnect after 90 seconds of silence
    - Implement Last Will and Testament for offline status messages
    - Support minimum 20 simultaneous connections
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 2. Implement backend scoring engine and data layer
  - [x] 2.1 Implement the composite probability scoring engine
    - Create `ScoringEngine` class implementing the interface from design
    - Weight CSI at 50%, acoustic at 35%, GPS proximity at 15%
    - Implement proportional weight redistribution when fewer than 3 sources have data
    - Exclude sources with no data in the last 10 minutes
    - Publish updated score on `cali/zone/{zone_id}/probability`
    - Emit priority alert on `cali/zone/{zone_id}/priority` when score exceeds 70
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 2.2 Implement WebSocket relay for mobile app connections
    - Create WebSocket server on port 9001 bridging mobile apps to MQTT broker
    - Handle `cali/sync/entries` messages: validate, deduplicate by entry ID, store in SQLite
    - Send `cali/sync/ack` acknowledgments with batch_id and confirmed entry_ids
    - Relay `cali/zone/+/csi` messages to subscribed mobile clients
    - _Requirements: 8.1, 8.2, 13.1, 13.2_

  - [ ]* 2.3 Write unit tests for scoring engine
    - Test weight redistribution with 1, 2, and 3 active sources
    - Test priority alert threshold at exactly 70 and above
    - Test source expiration after 10 minutes of no data
    - _Requirements: 11.2, 11.3, 11.4, 11.6_

- [x] 3. Implement real-time dashboard
  - [x] 3.1 Create dashboard HTML page with Leaflet.js map
    - Serve static dashboard at port 3000 via Express
    - Render all registered zones as colored markers (green <0.3, yellow 0.3–0.6, red ≥0.6, grey if no data)
    - Display latest motion_probability value on each zone marker
    - Ensure complete page load within 5 seconds for up to 50 zones
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 3.2 Implement ESP32 node status panel on dashboard
    - Show each node as online/offline based on 30-second message timeout
    - Update node status indicator within 5 seconds of timeout expiry
    - Subscribe to `cali/zone/+/status` for LWT messages
    - _Requirements: 7.5, 7.6_

  - [x] 3.3 Implement dashboard real-time updates via WebSocket
    - Subscribe to MQTT topics and push zone updates to dashboard clients
    - Update zone marker color within 1 second of CSI telemetry arrival
    - Display synced location entries as field report markers on the map
    - _Requirements: 7.2, 13.2_

- [ ] 4. Checkpoint - Backend verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement mobile app enhanced acoustic detection
  - [x] 5.1 Implement bandpass filter and audio processing pipeline
    - Create `mobile/` directory with Vite + React + TypeScript + vite-plugin-pwa setup via `pnpm create vite`
    - Install deps: `pnpm add react react-dom leaflet`, `pnpm add -D @types/react @types/react-dom @vitejs/plugin-react vite-plugin-pwa typescript`
    - Create `AudioEngine` component/hook with Web Audio API: `BiquadFilter` bandpass 200–4000Hz → `AnalyserNode` (fftSize=2048)
    - Compute RMS from time-domain data, update meter at ≥20 fps
    - Maintain noise floor with exponential smoothing (alpha=0.005, initial=0.02)
    - Classify peaks when RMS exceeds max(3.5× noise floor, 0.06)
    - _Requirements: 1.1, 1.6, 1.7_

  - [x] 5.2 Implement spectral centroid filtering and knock pattern detection
    - Compute spectral centroid over 50ms window centered on each peak
    - Discard peaks with centroid outside 300–3500Hz
    - Detect knock patterns: ≥3 filtered peaks in 6s, interval stdev <55% of mean, mean interval 200–2500ms
    - Trigger vibration + visual alert within 500ms, enforce 4-second cooldown between alerts
    - Handle devices without vibration support (visual alert only)
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [ ]* 5.3 Write unit tests for knock pattern detection logic
    - Test pattern recognition with regular intervals
    - Test rejection of irregular intervals (high stdev)
    - Test spectral centroid filtering
    - Test 4-second cooldown enforcement
    - _Requirements: 1.3, 1.4_

- [ ] 6. Implement mobile app GPS and location features
  - [x] 6.1 Implement location engine with encrypted localStorage persistence
    - Create `LocationEngine` and `EncryptedStorage` modules
    - AES-GCM encryption via Web Crypto API with device-fingerprint-derived key
    - Persist entries within 100ms of creation, append without overwriting
    - Handle malformed data recovery, quota exceeded, and unavailable localStorage
    - Implement in-memory fallback when localStorage is unavailable
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 2.1_

  - [ ] 6.2 Implement location sharing via Web Share API
    - Format share text: timestamp, accuracy, note, coordinates, Google Maps link
    - Fallback to clipboard copy with 2-second confirmation when Web Share unavailable
    - Handle empty log case with appropriate message
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [-] 6.3 Implement inline Leaflet.js map view
    - Render up to 200 location entries as markers, auto-fit viewport
    - Offline fallback: blank canvas with coordinate grid labels
    - Add markers dynamically without page reload
    - Show note and timestamp in popup on marker tap, 44×44px minimum touch targets
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [-] 6.4 Implement clear log with confirmation dialog
    - Present confirmation dialog requiring explicit accept action
    - Remove entries from both localStorage and in-memory collection on confirm
    - _Requirements: 5.4_

- [ ] 7. Implement mobile app connectivity and sync
  - [ ] 7.1 Implement WebSocket sync engine for backend communication
    - Create `SyncEngine` class: connect on port 9001 with 5-second timeout
    - Subscribe to `cali/zone/+/csi`, display alerts in notification panel (max 50 retained)
    - Retry every 5 seconds for up to 10 attempts, then show persistent offline indicator
    - Auto-resubscribe on reconnection, remove offline indicator within 2 seconds
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [~] 7.2 Implement remote location entry sync with acknowledgment
    - Transmit unsent entries in chronological order, batches of 50
    - Wait for backend acknowledgment before sending next batch
    - Retain entries on failure, reattempt on next connection
    - Display visual sync status indicator (synced vs unsynced)
    - Never delete entries until backend acknowledgment received
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [~] 7.3 Implement acoustic report submission to backend
    - Send knock pattern detection events to backend via WebSocket
    - Include zone proximity data for scoring engine incorporation
    - Backend must update probability score within 3 seconds of receipt
    - _Requirements: 11.5_

- [ ] 8. Implement PWA support and field usability
  - [~] 8.1 Configure vite-plugin-pwa with Workbox precaching
    - Configure `vite-plugin-pwa` in vite.config.ts with manifest, icons, and Workbox precache strategy
    - Include 192×192 and 512×512 icons in `public/` directory
    - Configure cache-first strategy for all static assets
    - Do not suppress browser's native install prompt
    - _Requirements: 4.1, 4.2, 4.5, 4.6_

  - [~] 8.2 Implement offline capability and non-HTTPS notice
    - Ensure acoustic detection and GPS logging work without network (service worker caches app shell)
    - Display notice when served over non-secure context (not HTTPS/localhost)
    - _Requirements: 4.3, 4.4_

  - [~] 8.3 Implement field usability requirements
    - All touch targets ≥48×48px with ≥8px spacing
    - Font sizes ≥14px body, ≥12px metadata, contrast ratio ≥4.5:1
    - Initial load <3 seconds on low-end devices (Snapdragon 450, 2GB RAM, Android 8.0)
    - Acoustic listener CPU <15% on reference device (30-second rolling average)
    - Graceful handling when available memory drops below 50MB
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [~] 9. Checkpoint - Mobile app verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement ESP32 CSI motion detection firmware
  - [x] 10.1 Set up ESP-IDF project structure and NVS configuration
    - Create `firmware/` directory with ESP-IDF project structure
    - Implement NVS configuration reader for zone_id, mqtt_host, mqtt_port, mqtt_psk, tx_rate, window_sz
    - Implement boot validation: halt with 4Hz LED blink if config missing or invalid
    - _Requirements: 9.5, 9.7_

  - [x] 10.2 Implement CSI ping transmission and motion probability calculation
    - Transmit Wi-Fi CSI ping frames at 20 fps
    - Measure subcarrier amplitude variance over sliding window of 40 samples (2 seconds)
    - Compute motion_probability (0.0–1.0) from variance
    - Publish to MQTT topic `cali/zone/{zone_id}/csi` every 2 seconds
    - _Requirements: 9.1, 9.2_

  - [x] 10.3 Implement LED indicator and power management
    - Activate onboard LED when motion_probability >0.6 for 3 consecutive readings
    - Deactivate LED when motion_probability <0.4 for 3 consecutive readings
    - Enter light-sleep between CSI cycles, maintain average <80mA over 60-second window
    - _Requirements: 9.3, 9.4_

  - [x] 10.4 Implement MQTT client with PSK authentication and buffering
    - Connect to broker with PSK from NVS config
    - Buffer up to 30 readings when broker unreachable, retry every 10 seconds
    - Discard oldest reading on buffer overflow
    - Configure Last Will and Testament for offline notification
    - _Requirements: 9.6, 6.5_

- [x] 11. Implement ESP32 network resilience
  - [x] 11.1 Implement Wi-Fi reconnection with exponential backoff
    - Continue CSI collection during Wi-Fi disconnection
    - Buffer up to 60 readings locally (ring buffer), discard oldest on overflow
    - Reconnect starting at 10s interval, doubling up to 60s maximum, indefinite attempts
    - _Requirements: 10.1, 10.2_

  - [x] 11.2 Implement buffered reading publication on reconnection
    - Publish all buffered readings in chronological order within 5 seconds of reconnection
    - Tag each reading with original capture timestamp
    - Retain unsent readings if connection drops during publication
    - _Requirements: 10.3, 10.4_

- [ ] 12. Integration and final wiring
  - [~] 12.1 Wire mobile app acoustic reports into backend scoring pipeline
    - Ensure acoustic reports from mobile are received, stored, and trigger probability recalculation
    - Verify updated scores are published and reach dashboard within 3 seconds
    - _Requirements: 11.5, 7.2_

  - [~] 12.2 Wire ESP32 CSI telemetry through full pipeline
    - Verify ESP32 → MQTT broker → scoring engine → dashboard update → mobile alert flow
    - Confirm message relay within 200ms at broker level
    - Confirm dashboard color update within 1 second
    - _Requirements: 6.2, 7.2, 8.2_

  - [~] 12.3 Wire mobile location sync through backend to dashboard
    - Verify mobile → WebSocket → backend storage → dashboard map markers flow
    - Confirm deduplication by unique identifier
    - Confirm field report markers appear on dashboard within 5 seconds
    - _Requirements: 13.1, 13.2_

  - [ ]* 12.4 Write integration tests for end-to-end data flows
    - Test CSI telemetry flow from simulated ESP32 to dashboard
    - Test acoustic report flow from mobile to scoring engine
    - Test location sync with acknowledgment and deduplication
    - Test priority alert emission when composite score exceeds 70
    - _Requirements: 6.2, 11.4, 13.2_

- [~] 13. Final checkpoint - Full system verification
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Implement AWS cloud bridge (laptop-side)
  - [ ] 14.1 Create cloud bridge service module in backend
    - Create `backend/src/cloud-bridge.ts` with `CloudBridge` class
    - Aggregate all zone probability scores from SQLite every 30 seconds
    - Collect active priority alerts and node connectivity status
    - POST aggregated payload to API Gateway endpoint via HTTPS (fetch/undici)
    - Authenticate with API key in Authorization header
    - Handle network failures gracefully: log warning, skip cycle, retry next interval
    - Never block the local system — bridge runs in background setInterval
    - _Requirements: Cloud bridge reliability, Property 22_

  - [ ] 14.2 Integrate bridge into backend server startup
    - Add `CLOUD_API_URL` and `CLOUD_API_KEY` environment variables (optional)
    - If both env vars are set, start bridge on server boot; otherwise skip silently
    - Log bridge status: "Cloud bridge active" or "Cloud bridge disabled (no config)"
    - Add `bridge.stop()` to graceful shutdown sequence
    - _Requirements: Zero-config local, cloud is optional_

- [ ] 15. Implement AWS Lambda + API Gateway + DynamoDB
  - [ ] 15.1 Create Lambda function for cloud ingest
    - Create `cloud/lambda/ingest.ts` — handler for POST /ingest
    - Validate API key from Authorization header
    - Parse `CloudIngestPayload`, validate zone array
    - Write each zone as LATEST item + timestamped history item to DynamoDB
    - Write active alerts to DynamoDB with TTL = 14 days
    - Write node status items
    - Return 200 with `{ acknowledged: true, zones_updated: N }`
    - _Requirements: Cloud ingest, Property 23, 25_

  - [ ] 15.2 Create Lambda function for dashboard API (GET endpoints)
    - Create `cloud/lambda/api.ts` — handler for GET /zones, /alerts, /nodes
    - `/zones`: Query all items with PK=ZONE#* and SK=LATEST
    - `/alerts`: Query items with PK=ALERT, last 50 by timestamp
    - `/nodes`: Query all items with SK=STATUS
    - Return JSON arrays sorted by relevance (alerts by time, zones by probability desc)
    - _Requirements: Remote dashboard data_

  - [ ] 15.3 Create infrastructure as code (CDK or SAM template)
    - Create `cloud/template.yaml` (SAM) or `cloud/cdk/` stack
    - Define: API Gateway REST API, 2 Lambda functions, DynamoDB table, S3 bucket, CloudFront distribution
    - Configure DynamoDB TTL on `expires_at` attribute
    - Configure API Gateway with API key requirement on POST /ingest
    - Configure CloudFront to serve S3 /dashboard/* and proxy /api/* to API Gateway
    - All resources within Free Tier sizing (128MB Lambda, on-demand DynamoDB)
    - _Requirements: Zero cost, deployable_

- [ ] 16. Implement remote dashboard (S3 static site)
  - [ ] 16.1 Create remote dashboard static HTML/JS
    - Create `cloud/dashboard/index.html` — single-page app
    - Leaflet.js map with zone markers (color-coded by probability)
    - Poll GET /zones every 10 seconds, update markers
    - Display alerts panel with last 10 priority alerts
    - Show node status indicators (online/offline)
    - Responsive layout, works on mobile and desktop
    - _Requirements: Remote coordinator visibility_

  - [ ] 16.2 Add deployment script for dashboard to S3
    - Create `cloud/deploy.sh` — uploads dashboard/* to S3 bucket
    - Invalidates CloudFront cache after upload
    - Requires AWS CLI configured with credentials
    - _Requirements: Easy deployment_

- [ ] 17. Implement ESP32 OTA firmware update
  - [ ] 17.1 Add OTA check module to ESP32 firmware
    - Create `firmware/main/ota_update.c` and `firmware/main/ota_update.h`
    - HTTP GET to CloudFront URL `/firmware/manifest.json` every 60 minutes
    - Parse JSON manifest: version, binary_url, binary_size, sha256
    - Compare manifest version with current version stored in NVS
    - If newer: download binary, verify SHA-256, flash to OTA partition, reboot
    - If same or download fails: continue normal operation, log error
    - Timeout: 30 seconds for manifest fetch, 120 seconds for binary download
    - _Requirements: Property 24, OTA correctness_

  - [ ] 17.2 Add OTA configuration to NVS schema
    - Add `ota_url` key to NVS config (CloudFront base URL for firmware)
    - Add `fw_version` key to NVS (current firmware version string)
    - Update `nvs_config.h` with new fields
    - If `ota_url` is empty/missing, OTA is disabled (local-only mode)
    - _Requirements: Optional OTA, backward compatible_

  - [ ] 17.3 Create firmware upload script
    - Create `cloud/upload-firmware.sh` — uploads .bin to S3 and updates manifest.json
    - Accepts version string and binary path as arguments
    - Computes SHA-256 of binary and writes manifest.json
    - Invalidates CloudFront cache for /firmware/*
    - _Requirements: Simple firmware deployment_

- [ ] 18. Cloud integration verification
  - [ ] 18.1 Test bridge → Lambda → DynamoDB flow
    - Verify bridge POST reaches Lambda and data appears in DynamoDB
    - Verify TTL is set correctly (14 days from write)
    - Verify duplicate payloads result in single LATEST item per zone
    - _Requirements: Property 22, 23, 25_

  - [ ] 18.2 Test remote dashboard displays live data
    - Deploy dashboard to S3/CloudFront
    - Verify zones appear on map with correct colors within 40 seconds of bridge upload
    - Verify alerts panel updates with priority alerts
    - _Requirements: Remote visibility_

  - [ ] 18.3 Test OTA firmware update end-to-end
    - Upload a test firmware binary to S3
    - Verify ESP32 detects new version and downloads (simulated or real)
    - Verify SHA-256 validation rejects corrupted binary
    - _Requirements: Property 24_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at tier boundaries
- The mobile app is a React + Vite PWA served from the backend (replaces single-file HTML)
- Mobile app lives in `mobile/` directory with its own `package.json` and pnpm workspace
- ESP32 firmware uses C with ESP-IDF framework
- Backend uses TypeScript with Node.js
- All data expires after 72 hours — no long-term storage
- Security: air-gapped network, PSK authentication, no PII, encrypted storage
- **CRITICAL: npm is PROHIBITED. Use `pnpm` exclusively for all package management (install, add, run, build). Never use `npm install` or `npm run`.**
- **CRITICAL: All UI text, comments, commits, and documentation must be in Spanish. Code identifiers (variables, functions, classes) in English.**

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "10.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "10.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "10.3", "10.4"] },
    { "id": 3, "tasks": ["2.3", "3.1", "5.1", "11.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "5.2", "6.1", "11.2"] },
    { "id": 5, "tasks": ["5.3", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["7.1", "7.2", "8.1"] },
    { "id": 7, "tasks": ["7.3", "8.2", "8.3"] },
    { "id": 8, "tasks": ["12.1", "12.2", "12.3"] },
    { "id": 9, "tasks": ["12.4"] },
    { "id": 10, "tasks": ["14.1", "15.1", "15.2", "15.3", "17.1"] },
    { "id": 11, "tasks": ["14.2", "16.1", "16.2", "17.2", "17.3"] },
    { "id": 12, "tasks": ["18.1", "18.2", "18.3"] }
  ]
}
```

**Cloud task dependencies:**
- Wave 10 can start in parallel with local system tasks (independent of waves 3–9)
- 14.1 requires 2.1 (scoring engine must exist to query zone scores)
- 14.2 requires 14.1
- 15.x are independent (can be developed before bridge if AWS account is ready)
- 16.x require 15.2 (dashboard needs API endpoints)
- 17.1 requires 10.1 (NVS config must exist)
- 17.2 requires 17.1
- 18.x require all of 14, 15, 16, 17 complete
