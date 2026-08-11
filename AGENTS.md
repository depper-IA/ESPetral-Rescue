# CALI Rescue — Project Context

## Purpose

Field tool to support search and rescue operations after the Cali disaster.
No professional rescue equipment replacement — strictly an aid for field teams.

## Current State

Single-file HTML app (`rescate_cali.html`) with two modes:

- **Acoustic listener**: microphone ? RMS meter ? rhythmic knock detection via Web Audio API
- **GPS logger**: geolocation + notes ? export as `.txt` or clipboard

## Stack

- HTML + CSS + Vanilla JS (no framework, no build step, no npm)
- Web Audio API (microphone access, FFT analysis)
- Geolocation API (GPS coordinates)
- Runs directly in the phone browser — no install required

## Architecture Constraints

- **Single file** — must stay portable (WhatsApp share, USB, QR code)
- **Offline first** — no internet required in the field
- **Mobile only** — max-width 520px, touch targets, vibration API
- **No backend** (for now) — all data stays local in memory

## Planned Evolution

When ESP32-C6 hardware arrives:

- Node.js + MQTT broker (online)
- Real-time dashboard with map
- ESP32 nodes connect and report Wi-Fi CSI motion signals
- ESPectre firmware flashed onto each chip

## Testing

None. No test runner, no linter, no CI.
This is an emergency field tool — shipping speed > test coverage.

## Key Files

| File | Description |
|------|-------------|
| `rescate_cali.html` | Main app — everything in one file |

## Open Work

- [ ] Share log via WhatsApp (Web Share API)
- [ ] Map view of marked GPS points (Leaflet.js inline)
- [ ] Send GPS marks to a remote endpoint (when backend exists)
- [ ] Improve rhythm detection (filter out wind/machinery noise)
- [ ] PWA manifest so it can be installed on home screen
- [ ] ESP32 firmware config (ESPectre YAML)
- [ ] Backend dashboard (Node.js + MQTT + map)

---

## Prompt de inicio (copiar y pegar en nueva sesión)

```
Contexto del proyecto CALI Rescue:

Estoy construyendo una herramienta de campo para búsqueda y rescate
tras el siniestro de Cali. El proyecto vive en o:\Proyectos\CALI\.

Archivos clave:
- App principal: o:\Proyectos\CALI\rescate_cali.html
- Contexto SDD:  o:\Proyectos\CALI\AGENTS.md

Repos de referencia que inspiran la parte de hardware:
- ESPectre (detección CSI via ESP32): https://github.com/francescopace/espectre
- Wi-Fi Sniffer (probe requests): https://github.com/SensorsIot/Wi-Fi-Sniffer-as-a-Human-detector

Hardware objetivo: ESP32-C6 Super Mini (~$38.900 COP en MercadoLibre Colombia)
https://www.mercadolibre.com.co/placa-desarrollo-esp32-c6-super-mini-wifi-6-ble-53-arduino/p/MCO2075579826

Estado actual:
- La app HTML ya existe: escucha acústica (micrófono) + GPS logger, sin backend, offline.
- El hardware ESP32 aún no está comprado.
- Próximo paso: [describir qué querés hacer hoy]

Iniciá SDD para este proyecto.
```
