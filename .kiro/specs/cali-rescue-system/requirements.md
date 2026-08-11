# Requirements Document

## Introduction

Integrated search and rescue detection system for the Cali disaster response. Combines acoustic detection, Wi-Fi CSI motion sensing (via ESP32-C6 nodes), and GPS location logging into a unified field tool that maximizes the probability of locating trapped survivors. The system comprises three deliverables: an enhanced single-file mobile web app, a Node.js backend with MQTT broker, and ESP32 firmware for Wi-Fi CSI detection.

## Glossary

- **Mobile_App**: The single-file HTML/CSS/JS progressive web application used by rescue teams in the field on Android phones
- **Backend**: Node.js server running on a laptop at the rescue site, hosting the MQTT broker and WebSocket relay
- **ESP32_Node**: An ESP32-C6 Super Mini device running CSI detection firmware, deployed around rubble zones
- **MQTT_Broker**: Message broker (Aedes or Mosquitto) running on the Backend that relays ESP32_Node telemetry
- **CSI**: Channel State Information — Wi-Fi subcarrier amplitude/phase data used to detect micro-movements
- **Zone**: A logical area of the rescue site where one or more ESP32_Nodes are deployed
- **Probability_Indicator**: A composite score (0–100) representing likelihood of a trapped survivor in a Zone
- **Rescue_Worker**: Field team member carrying the Mobile_App on their phone
- **Location_Entry**: A GPS-tagged record containing coordinates, timestamp, accuracy, and notes
- **Knock_Pattern**: A sequence of 3 or more audio peaks with regular timing intervals (200ms–2500ms between peaks, standard deviation below 55% of mean interval)
- **RMS**: Root Mean Square — a measure of audio signal amplitude
- **Noise_Floor**: The slow-moving average ambient sound level used as a baseline reference
- **PWA**: Progressive Web App — web application with service worker enabling offline use and home-screen install

## Requirements

### Requirement 1: Enhanced Acoustic Detection

**User Story:** As a Rescue_Worker, I want the acoustic listener to distinguish human knocks from wind and machinery noise, so that I get fewer false alerts in noisy field conditions.

#### Acceptance Criteria

1. WHEN the Rescue_Worker activates the acoustic listener, THE Mobile_App SHALL apply a bandpass filter (200 Hz–4000 Hz) to the audio stream before peak detection
2. WHEN a peak is detected, THE Mobile_App SHALL compute the spectral centroid over a 50 ms window centered on the peak and discard peaks whose spectral centroid falls outside 300 Hz–3500 Hz
3. WHEN 3 or more filtered peaks occur within a 6-second window with interval standard deviation below 55% of mean interval and mean interval between 200 ms and 2500 ms, THE Mobile_App SHALL flag the event as a Knock_Pattern
4. WHEN a Knock_Pattern is detected, THE Mobile_App SHALL vibrate the device and display a visual alert within 500 ms of detection, and SHALL not raise another alert for the same listening session until at least 4 seconds have elapsed since the previous alert
5. IF a Knock_Pattern is detected and the device does not support vibration, THEN THE Mobile_App SHALL display the visual alert without vibration
6. WHILE the acoustic listener is active, THE Mobile_App SHALL update the RMS meter at a minimum of 20 frames per second
7. WHILE the acoustic listener is active, THE Mobile_App SHALL maintain a Noise_Floor baseline using exponential smoothing (alpha = 0.005) initialized at 0.02 RMS, and SHALL classify a sample as a peak when its RMS exceeds 3.5 times the current Noise_Floor or 0.06 RMS, whichever is greater

### Requirement 2: GPS Location Sharing

**User Story:** As a Rescue_Worker, I want to share my logged locations via WhatsApp or other apps, so that I can quickly relay findings to the coordination team.

#### Acceptance Criteria

1. WHEN the Rescue_Worker taps the share button on a single Location_Entry, THE Mobile_App SHALL invoke the Web Share API with text containing that entry's coordinates, timestamp, accuracy, note, and a Google Maps link formatted as a multi-line plain text block
2. IF the Web Share API is not available on the device, THEN THE Mobile_App SHALL copy the Location_Entry text to the clipboard and display a confirmation message visible for at least 2 seconds indicating the text was copied
3. IF the Rescue_Worker taps the share button and no Location_Entry exists in the current session, THEN THE Mobile_App SHALL not invoke the share action and SHALL display a message indicating there is nothing to share
4. WHEN sharing a single Location_Entry, THE Mobile_App SHALL include all fields in this order: timestamp, accuracy in meters, note text, coordinates as "lat, lon", and a Google Maps link in the format "https://maps.google.com/?q={lat},{lon}"

### Requirement 3: Inline Map View

**User Story:** As a Rescue_Worker, I want to see my marked locations on a map within the app, so that I can visualize the search coverage without switching apps.

#### Acceptance Criteria

1. WHEN the Rescue_Worker opens the map view, THE Mobile_App SHALL render all stored Location_Entries (up to 200) as markers on a Leaflet.js map, with the viewport auto-fitted to show all markers within visible bounds
2. IF no internet connection is available, THEN THE Mobile_App SHALL display markers over a blank canvas with coordinate grid labels instead of tile imagery
3. WHEN a new Location_Entry is created, THE Mobile_App SHALL add the corresponding marker to the map without requiring a page reload
4. WHEN the Rescue_Worker taps a marker on the map, THE Mobile_App SHALL display the associated note and timestamp in a popup, and dismiss the popup when the Rescue_Worker taps outside of it or taps another marker
5. THE Mobile_App SHALL render map markers with a minimum touch target of 44×44 CSS pixels to ensure usability on small mobile screens

### Requirement 4: Progressive Web App Support

**User Story:** As a Rescue_Worker, I want to install the app on my phone's home screen, so that I can launch it instantly without opening the browser.

#### Acceptance Criteria

1. THE Mobile_App SHALL include a PWA manifest (inline JSON or blob-URL registered via JavaScript) containing: `name`, `short_name`, `start_url`, `display` set to `standalone`, `theme_color`, `background_color`, and an `icons` array with at least one 192×192px and one 512×512px PNG icon (icons may be base64 data URIs to preserve the single-file constraint)
2. THE Mobile_App SHALL register a service worker (via blob URL generated from an inline script within the HTML file) that caches the HTML file itself and any Leaflet.js library assets using a cache-first strategy
3. WHEN the device loses network connectivity, THE Mobile_App SHALL continue to provide acoustic detection (microphone listening and rhythmic knock analysis) and GPS coordinate logging with note capture and export, without requiring a network connection
4. IF the app is served over a non-secure context (not HTTPS and not localhost), THEN THE Mobile_App SHALL display a visible notice informing the user that home-screen installation requires HTTPS or localhost, and that offline features may be limited
5. THE Mobile_App SHALL remain a single HTML file where the service worker script and PWA manifest are defined inline within the HTML document and registered programmatically via blob URLs or equivalent in-memory references, requiring no external files
6. WHEN the browser determines the app meets installability criteria, THE Mobile_App SHALL not suppress the browser's native install prompt (beforeinstallprompt event), allowing the user to add the app to their home screen through the standard browser mechanism

### Requirement 5: Data Persistence

**User Story:** As a Rescue_Worker, I want my logged data to survive app crashes and accidental tab closures, so that I do not lose critical location records in the field.

#### Acceptance Criteria

1. WHEN a new Location_Entry is created, THE Mobile_App SHALL persist the entry to localStorage within 100ms of creation, appending it to the existing stored collection without overwriting previous entries
2. WHEN the Mobile_App is opened, THE Mobile_App SHALL read all Location_Entries from localStorage and display them in the log section in reverse chronological order. IF the stored data is malformed or unparseable, THEN THE Mobile_App SHALL discard the corrupted data, start with an empty log, and display a warning indicating that previous records could not be recovered
3. IF a localStorage write fails for any reason (quota exceeded, storage unavailable, or private browsing mode), THEN THE Mobile_App SHALL retain the Location_Entry in the current in-memory session, display a warning visible until dismissed indicating that the entry was not saved to persistent storage, and allow the Rescue_Worker to continue logging subsequent entries in memory
4. WHEN the Rescue_Worker explicitly clears the log, THE Mobile_App SHALL present a confirmation dialog requiring an explicit accept action before removing all Location_Entries from both localStorage and the in-memory collection
5. WHEN the Mobile_App is opened in an environment where localStorage is entirely unavailable, THE Mobile_App SHALL display a persistent notice indicating that entries will not survive page closure, and SHALL allow the Rescue_Worker to continue logging entries in memory for the current session

### Requirement 6: Backend MQTT Broker

**User Story:** As a Rescue_Worker, I want ESP32 nodes to report motion detection data through a central broker, so that all sensor readings are aggregated in one place.

#### Acceptance Criteria

1. THE Backend SHALL host an MQTT broker accepting connections on port 1883 (MQTT) and port 9001 (WebSocket), supporting a minimum of 20 simultaneous client connections
2. WHEN an ESP32_Node publishes a CSI telemetry message, THE MQTT_Broker SHALL relay the message to all subscribed clients within 200ms
3. THE Backend SHALL accept MQTT messages with a maximum payload size of 1 KB on the topic pattern `cali/zone/{zone_id}/csi` containing JSON with fields: zone_id (string, 1–64 characters), timestamp (ISO 8601 format), motion_probability (float, 0.0–1.0 inclusive), and node_id (string, 1–64 characters)
4. IF an ESP32_Node publishes a message to `cali/zone/{zone_id}/csi` with missing required JSON fields or with motion_probability outside the 0.0–1.0 range, THEN THE MQTT_Broker SHALL discard the message and SHALL NOT relay it to subscribed clients
5. IF an ESP32_Node disconnects unexpectedly, THEN THE Backend SHALL publish a last-will message on `cali/zone/{zone_id}/status` containing JSON with fields: node_id, zone_id, status set to "offline", and timestamp in ISO 8601 format
6. THE Backend SHALL configure a keep-alive interval of 60 seconds for all MQTT client connections, and SHALL consider a client disconnected if no PINGREQ is received within 1.5 times the keep-alive interval (90 seconds)

### Requirement 7: Real-Time Dashboard Map

**User Story:** As a Rescue_Worker, I want a dashboard showing all zones with their motion detection status on a map, so that I can prioritize which areas to investigate.

#### Acceptance Criteria

1. THE Backend SHALL serve a web dashboard accessible via HTTP on the local network at port 3000, returning a complete page load within 5 seconds for up to 50 registered Zones
2. WHEN a CSI telemetry message arrives, THE Dashboard SHALL update the corresponding Zone marker color within 1 second: green for motion_probability strictly below 0.3, yellow for motion_probability from 0.3 up to but not including 0.6, and red for motion_probability of 0.6 or above
3. WHEN the Rescue_Worker opens the dashboard, THE Dashboard SHALL display all registered Zones as markers on a Leaflet.js map, each showing its latest motion_probability value and colored according to the thresholds defined in criterion 2
4. IF a Zone has not received any CSI telemetry message since the Backend started, THEN THE Dashboard SHALL display that Zone marker in grey to indicate no data available
5. THE Dashboard SHALL display an ESP32_Node connection status panel showing each node as online or offline, where a node is marked offline if no message has been received from it within the last 30 seconds
6. IF an ESP32_Node transitions from online to offline, THEN THE Dashboard SHALL update that node's status indicator within 5 seconds of the timeout expiring

### Requirement 8: Mobile App to Backend Connection

**User Story:** As a Rescue_Worker, I want my mobile app to receive real-time zone alerts from the backend when I am within range of the local network, so that I get notified of detected motion without checking the dashboard laptop.

#### Acceptance Criteria

1. WHEN the Mobile_App detects an active Wi-Fi connection, THE Mobile_App SHALL attempt a WebSocket connection to the Backend on port 9001 with a connection timeout of 5 seconds
2. WHILE connected via WebSocket, THE Mobile_App SHALL subscribe to `cali/zone/+/csi` and display each incoming motion alert in a notification panel showing the zone identifier and a timestamp, retaining the most recent 50 alerts
3. IF the WebSocket connection is lost, THEN THE Mobile_App SHALL retry connection every 5 seconds for up to 10 attempts, then display a persistent offline indicator visible on all app screens
4. WHILE disconnected from the Backend, THE Mobile_App SHALL continue operating all local features (acoustic detection, GPS logging) with no loss of functionality or data
5. WHEN the Mobile_App re-establishes a WebSocket connection after a disconnection, THE Mobile_App SHALL automatically re-subscribe to `cali/zone/+/csi` and remove the offline indicator within 2 seconds of successful reconnection

### Requirement 9: ESP32 CSI Motion Detection Firmware

**User Story:** As a Rescue_Worker, I want ESP32 nodes placed around rubble to detect micro-movements via Wi-Fi signals, so that I can find trapped people who are too weak to knock.

#### Acceptance Criteria

1. THE ESP32_Node SHALL transmit Wi-Fi CSI ping frames at a rate of 20 frames per second, measure subcarrier amplitude variance over a sliding window of 40 samples (2 seconds), and compute a motion_probability value (0.0–1.0)
2. THE ESP32_Node SHALL publish motion_probability to the MQTT_Broker every 2 seconds on topic `cali/zone/{zone_id}/csi`
3. WHEN motion_probability exceeds 0.6 for 3 consecutive readings, THE ESP32_Node SHALL activate its onboard LED as a local visual indicator and keep it active until motion_probability falls below 0.4 for 3 consecutive readings
4. THE ESP32_Node SHALL enter light-sleep mode between CSI measurement cycles to maintain average power consumption below 80 mA measured over any 60-second rolling window
5. WHEN the ESP32_Node boots, THE ESP32_Node SHALL read zone_id and MQTT broker address from a configuration stored in NVS (non-volatile storage)
6. IF the MQTT_Broker is unreachable at publish time, THEN THE ESP32_Node SHALL buffer up to 30 motion_probability readings locally and retry publication every 10 seconds until the connection is restored or the buffer is full, discarding the oldest reading when the buffer overflows
7. IF NVS configuration is missing or contains an invalid zone_id (empty string) or invalid MQTT broker address (empty string or unreachable host) at boot, THEN THE ESP32_Node SHALL blink its onboard LED in a rapid pattern (4 Hz) continuously and halt normal operation until valid configuration is provided

### Requirement 10: ESP32 Network Resilience

**User Story:** As a Rescue_Worker, I want ESP32 nodes to handle Wi-Fi disconnections gracefully, so that nodes keep working even with unstable field connectivity.

#### Acceptance Criteria

1. IF the ESP32_Node loses Wi-Fi connection, THEN THE ESP32_Node SHALL continue collecting CSI readings and buffer up to 60 readings locally, discarding the oldest reading when the buffer is full
2. IF the MQTT_Broker is unreachable for more than 30 seconds, THEN THE ESP32_Node SHALL attempt reconnection starting at a 10-second interval with exponential backoff, doubling the interval on each failed attempt up to a maximum interval of 60 seconds, and continuing attempts indefinitely until connection is restored
3. WHEN the ESP32_Node reconnects to the MQTT_Broker, THE ESP32_Node SHALL publish all buffered readings in chronological order within 5 seconds, tagging each reading with its original capture timestamp to prevent duplicate processing
4. IF the connection drops while buffered readings are being published, THEN THE ESP32_Node SHALL retain any unsent readings in the buffer and re-attempt publishing them on the next successful reconnection

### Requirement 11: Unified Probability Scoring

**User Story:** As a Rescue_Worker, I want a single probability-of-life indicator per zone combining all detection methods, so that I can make quick prioritization decisions.

#### Acceptance Criteria

1. WHEN the Backend receives data from at least one detection source (CSI, acoustic reports, GPS proximity) for a Zone, THE Backend SHALL compute a composite Probability_Indicator as an integer value between 0 and 100 inclusive, and publish the updated score on MQTT topic `cali/zone/{zone_id}/probability`
2. THE Backend SHALL weight CSI motion detection at 50%, acoustic Knock_Pattern reports at 35%, and GPS activity from devices located within 50 meters of the Zone center and reported within the last 30 minutes at 15% in the composite score
3. IF fewer than three detection sources have contributed data for a Zone, THEN THE Backend SHALL redistribute the weights of missing sources proportionally among the available sources when computing the Probability_Indicator
4. WHEN a Zone Probability_Indicator exceeds 70, THE Backend SHALL emit a priority alert on MQTT topic `cali/zone/{zone_id}/priority`
5. WHEN the Rescue_Worker submits an acoustic detection report from the Mobile_App, THE Backend SHALL incorporate the report into the Zone Probability_Indicator and publish the updated score on `cali/zone/{zone_id}/probability` within 3 seconds of receiving the report
6. IF a detection source has not provided new data for a Zone within 10 minutes, THEN THE Backend SHALL exclude that source from the composite calculation and redistribute its weight among remaining active sources

### Requirement 12: Field Usability

**User Story:** As a Rescue_Worker, I want the app to be usable with gloves and dirty hands on a cheap Android phone, so that the tool works in real disaster conditions.

#### Acceptance Criteria

1. THE Mobile_App SHALL render all interactive elements (buttons, markers, controls) with a minimum touch target of 48x48 CSS pixels and a minimum spacing of 8 CSS pixels between adjacent touch targets
2. THE Mobile_App SHALL use a font size no smaller than 14px for all body text and 12px for metadata labels, and SHALL maintain a minimum contrast ratio of 4.5:1 between text and its background
3. THE Mobile_App SHALL launch without errors, render both the acoustic listener and GPS logger views, and respond to user interactions within 2 seconds on devices with 2GB RAM or less running Android 8.0 or later
4. THE Mobile_App SHALL complete initial load (all interactive elements rendered and responsive to touch) within 3 seconds on a reference low-end device (Qualcomm Snapdragon 450 or equivalent, 2GB RAM, Android 8.0) without requiring any network requests for core functionality
5. WHILE the acoustic listener is active, THE Mobile_App SHALL consume less than 15% CPU on a reference low-end device (Qualcomm Snapdragon 450 or equivalent, 2GB RAM) measured as a 30-second rolling average
6. IF available device memory drops below 50MB while the app is running, THEN THE Mobile_App SHALL continue operating the active mode (acoustic listener or GPS logger) without crashing or losing previously recorded GPS entries

### Requirement 13: Remote Location Sync

**User Story:** As a Rescue_Worker, I want my location logs to sync to the backend when available, so that the coordination team has access to all field data from the dashboard.

#### Acceptance Criteria

1. WHEN the Mobile_App establishes a WebSocket connection to the Backend, THE Mobile_App SHALL transmit all unsent Location_Entries to the Backend in chronological order, in batches of up to 50 entries, waiting for Backend acknowledgment of each batch before sending the next
2. WHEN the Backend receives Location_Entries, THE Backend SHALL store them, deduplicate entries by their unique identifier, and display them on the dashboard map as field report markers within 5 seconds of receipt
3. IF the sync transmission fails due to a WebSocket error event, connection drop, or no Backend acknowledgment received within 30 seconds, THEN THE Mobile_App SHALL retain the Location_Entries in local persistent storage and reattempt transmission on the next successful WebSocket connection
4. WHEN the Backend sends an acknowledgment for a Location_Entry, THE Mobile_App SHALL mark the entry with a visual sync status indicator that distinguishes synced entries from unsynced entries in the Rescue_Worker's location log view
5. THE Mobile_App SHALL persist all Location_Entries in local storage such that entries survive app restarts and are never deleted until Backend acknowledgment is received
