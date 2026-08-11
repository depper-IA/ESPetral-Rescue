<div align="center">

# ESPetral Rescue

**Open-source field tool for search and rescue operations**
Wi-Fi CSI motion detection · Acoustic knock sensing · GPS logging · Real-time dashboard
Built in response to the Cali, Colombia disaster · By [Sam Wilkie](https://github.com/depper-IA)

[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-5.x-red?style=flat-square&logo=espressif&logoColor=white)](https://docs.espressif.com/projects/esp-idf)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

---

## What It Is

ESPetral Rescue is a multi-component detection system designed to help search and rescue teams locate trapped survivors in collapsed structures. It runs offline-first on a laptop at the rescue site and optionally syncs to AWS for remote coordination.

**Not a replacement for professional rescue equipment** — a force multiplier for field teams working with limited resources.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  RUBBLE ZONE                                                 │
│  ESP32-C6 nodes → Wi-Fi CSI motion detection (20 fps)       │
└──────────────────────┬───────────────────────────────────────┘
                       │ MQTT over local Wi-Fi
┌──────────────────────▼───────────────────────────────────────┐
│  RESCUE SITE LAPTOP                                          │
│  MQTT Broker · Scoring Engine · SQLite · Dashboard           │
└──────────┬──────────────────────────┬────────────────────────┘
           │ WebSocket                │ HTTPS every 30s (optional)
┌──────────▼──────────┐  ┌───────────▼────────────────────────┐
│  Mobile PWA          │  │  AWS (Free Tier)                   │
│  Acoustic detection  │  │  API GW · Lambda · DynamoDB · S3   │
│  GPS logger          │  │  Remote dashboard · OTA firmware    │
│  Offline-first       │  │  (only when internet available)    │
└─────────────────────┘  └────────────────────────────────────┘
```

**Detection sources fused into a single Probability Indicator per zone:**

| Source | Weight | Method |
|--------|--------|--------|
| Wi-Fi CSI (ESP32) | 50% | Subcarrier amplitude variance over 2s sliding window |
| Acoustic (mobile) | 35% | Knock pattern detection via Web Audio API (bandpass + spectral centroid) |
| GPS proximity | 15% | Field team location density near zone center |

---

## Components

### `firmware/` — ESP32-C6 Firmware (C · ESP-IDF)
- Wi-Fi CSI ping at 20 fps, motion probability computation
- MQTT publish every 2s with circular buffer for offline resilience
- LED hysteresis indicator, light-sleep power management (<80mA avg)
- OTA firmware updates via S3/CloudFront

### `backend/` — Local Server (TypeScript · Node.js)
- Aedes MQTT broker (PSK auth, payload validation)
- SQLite database with SQLCipher encryption + 72h auto-purge
- Composite probability scoring engine (CSI + acoustic + GPS)
- WebSocket relay for mobile apps
- Express dashboard server (port 3000)
- Cloud bridge: aggregates zone data and uploads to AWS every 30s

### `mobile/` — Field PWA (React · Vite · TypeScript)
- Acoustic knock detection with bandpass filtering and spectral centroid analysis
- GPS location logger with encrypted localStorage persistence
- Leaflet.js map view of logged points
- WebSocket sync to backend when in range, offline-first when not

### `cloud/` — AWS Free Tier Layer (SAM · Lambda · DynamoDB · S3)
- API Gateway + Lambda: receives 30s aggregated summaries from bridge
- DynamoDB single-table: zone state, alerts, node status (14-day TTL)
- S3 + CloudFront: remote dashboard + OTA firmware distribution
- Zero cost for 14-day operation (designed for a single rescue event)

---

## System Requirements

| Component | Hardware |
|-----------|---------|
| Detection nodes | ESP32-C6 Super Mini (~$38,900 COP / ~$10 USD) |
| Coordination | Laptop with Node.js 20+ and Wi-Fi hotspot capability |
| Field team | Any Android/iOS phone with a modern browser |
| Network | Local Wi-Fi only — no internet required for field operation |

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/depper-IA/ESPetral-Rescue.git
cd ESPetral-Rescue
```

### 2. Start the backend

```bash
cd backend
pnpm install
pnpm run dev
# Dashboard: http://localhost:3000
# MQTT Broker: port 1883 (TCP) / 9001 (WS)
```

### 3. Flash the firmware

```bash
cd firmware
idf.py set-target esp32c6
idf.py menuconfig   # Set NVS: zone_id, mqtt_host, mqtt_token
idf.py build flash monitor
```

### 4. Open the mobile app

Connect your phone to the laptop's Wi-Fi hotspot, then open:
```
http://<laptop-ip>:3000
```

### 5. (Optional) Deploy cloud layer

```bash
cd cloud
cp .env.example .env   # Add AWS credentials
pnpm run deploy
```

---

## Operational Design

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Data retention (local) | 72 hours | Emergency tool, not an archive |
| Data retention (cloud) | 14 days | Covers 100% of documented earthquake survivals |
| Alert threshold | >70% composite score | Triggers priority alert to all clients |
| Source staleness | 10 minutes | Source excluded from score if no new data |
| Max survivors window | 14 days | Literature: avg max 6.8 days, documented max 14 days |

---

## Security

- **Air-gapped local network** — no cloud traffic unless explicitly configured
- **SQLCipher** — database encrypted at rest
- **PSK token auth** — MQTT devices authenticate with pre-shared tokens
- **GPS as PII** — coordinates encrypted in transit and at rest
- **No cloud PII** — cloud layer stores only zone center coordinates, never individual GPS tracks

---

## Stack

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![MQTT](https://img.shields.io/badge/MQTT-660066?style=flat-square&logo=mqtt&logoColor=white)
![ESP32](https://img.shields.io/badge/ESP32--C6-E7352C?style=flat-square&logo=espressif&logoColor=white)
![AWS Lambda](https://img.shields.io/badge/AWS_Lambda-FF9900?style=flat-square&logo=awslambda&logoColor=white)
![DynamoDB](https://img.shields.io/badge/DynamoDB-4053D6?style=flat-square&logo=amazondynamodb&logoColor=white)
![CloudFront](https://img.shields.io/badge/CloudFront-FF9900?style=flat-square&logo=amazonaws&logoColor=white)

</div>

---

## Related Projects

| Project | What it is |
|---------|-----------|
| [Lookitry](https://github.com/depper-IA/lookitry-showcase) | AI Virtual Try-On SaaS · Next.js · Supabase |
| [kommo-mcp](https://github.com/depper-IA/kommo-mcp) | MCP server for Kommo CRM · Python · OAuth2 |
| [Sammy](https://github.com/depper-IA/sammy) | AI Telegram assistant · TypeScript · SQLite |
| [Rendertry](https://github.com/depper-IA/Rendertry) | Automotive customization visualizer · Vanilla JS |
| [WilkieDevs](https://github.com/depper-IA/WilkieDevs) | Web automation platform · AI chatbot |

---

<div align="center">

*Built from Cali, Colombia — for whoever needs it.*

</div>
