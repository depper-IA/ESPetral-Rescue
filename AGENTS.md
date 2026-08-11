# CALI Rescue / ESPetral Rescue — Contexto de Agente

## Propósito

Herramienta de campo para operaciones de búsqueda y rescate tras el siniestro en Cali, Colombia.
No es un reemplazo de equipos profesionales de rescate — es una ayuda y multiplicador de fuerza para equipos de campo.

## Estado Actual del Sistema

El proyecto evolucionó de un archivo único HTML a un sistema multicomponente de 3 niveles principales + capa en la nube:

1. **`mobile/` (PWA Móvil en React + Vite + TypeScript)**:
   - Detección acústica con filtro pasabanda (200–4000 Hz) y centroide espectral.
   - Registrador de ubicaciones GPS con almacenamiento encriptado (AES-GCM).
   - Mapa con Leaflet.js y sincronización WebSocket con el backend local.

2. **`backend/` (Servidor Local Node.js + TypeScript)**:
   - Broker MQTT Aedes (puertos 1883 y 9001).
   - Base de datos SQLite con SQLCipher y auto-purga a las 72 horas.
   - Motor de puntuación compuesta de probabilidad (CSI 50%, Acústica 35%, GPS 15%).
   - Servidor Express y panel de control (puerto 3000).

3. **`firmware/` (ESP32 Multi-Chip en C / ESP-IDF)**:
   - Código agnóstico de target compatible con **ESP32-S3** (S3 preferido/donado para pruebas de alto rendimiento), **ESP32-C6** y **ESP32-C3**.
   - Ráfagas CSI ping a 20 fps para análisis de varianza de subportadoras.
   - Publicación MQTT con búfer circular para resiliencia sin conexión.
   - Gestión de energía y suspensión ligera.

4. **`cloud/` (Opcional - AWS Free Tier)**:
   - Puente servidor-a-nube, API Gateway, Lambda, DynamoDB y distribución de firmware OTA.

## Reglas de Arquitectura

- **Offline-first**: Todo funciona en la red local del sitio de rescate sin necesidad de internet.
- **Gestor de paquetes**: **`pnpm` exclusivo**. Totalmente prohibido el uso de `npm`.
- **Idioma**: Comentarios, documentación, mensajes y commits en **Español**. Identificadores de código en Inglés.
- **Sin emojis**: Mantener una presentación limpia sin emojis en interfaces o documentos.

## Archivos Clave

| Archivo / Directorio | Descripción |
|----------------------|-------------|
| `README.md` | Documentación principal en español |
| `REGLAS_IMPORTANTES.md` | Protocolo obligatorio y reglas de desarrollo |
| `AGENTS.md` | Contexto para asistentes e IAs |
| `mobile/` | PWA de campo |
| `backend/` | Servidor central y broker MQTT |
| `firmware/` | Código para nodos ESP32 (S3/C6/C3) |
