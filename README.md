<div align="center">

# ESPetral Rescue

**Herramienta de código abierto para operaciones de búsqueda y rescate en campo**
Detección de movimiento Wi-Fi CSI · Sensor acústico de golpes · Registro GPS · Panel en tiempo real
Desarrollado en respuesta a la emergencia en Cali, Colombia · Por [Sam Wilkie](https://github.com/depper-IA)

[![Licencia](https://img.shields.io/badge/Licencia-MIT-green?style=flat-square)](LICENSE)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-5.x-red?style=flat-square&logo=espressif&logoColor=white)](https://docs.espressif.com/projects/esp-idf)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

---

## Qué Es

ESPetral Rescue es un sistema de detección multicomponente diseñado para ayudar a los equipos de búsqueda y rescate a localizar personas atrapadas en estructuras colapsadas. Opera bajo la filosofía offline-first (desconectado primero) desde un computador portátil en el sitio de rescate y, opcionalmente, se sincroniza con AWS para coordinación remota.

**No es un reemplazo para equipos de rescate profesionales**: es un multiplicador de fuerza para equipos de campo que trabajan con recursos limitados.

---

## Cómo Funciona

```
┌─────────────────────────────────────────────────────────────┐
│  ZONA DE ESCOMBROS                                          │
│  Nodos ESP32-C6 → Detección de movimiento Wi-Fi CSI (20 fps)│
└──────────────────────┬──────────────────────────────────────┘
                       │ MQTT sobre Wi-Fi local
┌──────────────────────▼──────────────────────────────────────┐
│  PORTÁTIL DE RESCATE (SITIO DE CAMPO)                       │
│  Broker MQTT · Motor de Puntuación · SQLite · Dashboard     │
└──────────┬──────────────────────────┬───────────────────────┘
           │ WebSocket                │ HTTPS cada 30s (opcional)
┌──────────▼──────────┐  ┌───────────▼────────────────────────┐
│  PWA Móvil de Campo │  │  AWS (Capa Gratuita)               │
│  Detección acústica │  │  API GW · Lambda · DynamoDB · S3   │
│  Registrador GPS    │  │  Dashboard remoto · Firmware OTA   │
│  Offline-first      │  │  (solo si hay internet disponible) │
└─────────────────────┘  └────────────────────────────────────┘
```

**Fuentes de detección fusionadas en un indicador único de probabilidad por zona:**

| Fuente | Peso | Método |
|--------|------|--------|
| Wi-Fi CSI (ESP32) | 50% | Varianza de amplitud de subportadoras en ventana móvil de 2s |
| Acústica (móvil) | 35% | Detección de patrones de golpes vía Web Audio API (filtro pasabanda + centroide espectral) |
| Proximidad GPS | 15% | Densidad de ubicación de equipos de campo cerca del centro de zona |

---

## Componentes

### `firmware/` — Firmware ESP32-C6 (C · ESP-IDF)
- Transmisión CSI ping a 20 fps y cálculo de probabilidad de movimiento
- Publicación MQTT cada 2s con búfer circular para resiliencia sin conexión
- Indicador LED con histéresis y gestión de energía en suspensión ligera (<80mA promedio)
- Actualizaciones de firmware OTA mediante S3 y CloudFront

### `backend/` — Servidor Local (TypeScript · Node.js)
- Broker MQTT Aedes con autenticación PSK y validación de esquemas
- Base de datos SQLite con encriptación SQLCipher y auto-purga a las 72 horas
- Motor de puntuación de probabilidad compuesta (CSI + acústica + GPS)
- Relay WebSocket para la aplicación móvil
- Servidor de panel de control Express (puerto 3000)
- Puente a la nube: agrega datos de zona y los envía a AWS cada 30s

### `mobile/` — PWA de Campo (React · Vite · TypeScript)
- Detección acústica de golpes con filtro pasabanda y análisis de centroide espectral
- Registrador de ubicaciones GPS con almacenamiento local encriptado
- Vista de mapa con Leaflet.js para puntos registrados
- Sincronización WebSocket con el servidor local al estar en rango, 100% offline cuando no

### `cloud/` — Capa AWS Free Tier (SAM · Lambda · DynamoDB · S3)
- API Gateway + Lambda: recibe resúmenes agregados cada 30s desde el puente
- Tabla única DynamoDB: estado de zonas, alertas y estado de nodos (TTL de 14 días)
- S3 + CloudFront: panel de control remoto y distribución de firmware OTA
- Cero costo durante 14 días de operación continua (diseñado para un evento de rescate)

---

## Requisitos del Sistema

| Componente | Hardware |
|-----------|----------|
| Nodos de detección | ESP32-C6 Super Mini (~$38.900 COP / ~$10 USD) |
| Coordinación | Computador portátil con Node.js 20+ y zona de cobertura Wi-Fi (Hotspot) |
| Equipo de campo | Cualquier teléfono Android o iOS con navegador web moderno |
| Red | Red Wi-Fi local únicamente — no requiere internet para operación en campo |

---

## Guía de Inicio

### 1. Clonar el repositorio

```bash
git clone https://github.com/depper-IA/ESPetral-Rescue.git
cd ESPetral-Rescue
```

### 2. Iniciar el servidor backend

```bash
cd backend
pnpm install
pnpm run dev
# Panel de control: http://localhost:3000
# Broker MQTT: puerto 1883 (TCP) / 9001 (WS)
```

### 3. Compilar y flashear el firmware

```bash
cd firmware
idf.py set-target esp32c6
idf.py menuconfig   # Configurar NVS: zone_id, mqtt_host, mqtt_token
idf.py build flash monitor
```

### 4. Abrir la aplicación móvil

Conectar el teléfono a la red Wi-Fi del computador portátil y abrir en el navegador:
```
http://<ip-del-portatil>:3000
```

### 5. (Opcional) Desplegar la capa en la nube

```bash
cd cloud
cp .env.example .env   # Configurar credenciales de AWS
pnpm run deploy
```

---

## Diseño Operativo

| Parámetro | Valor | Justificación |
|-----------|-------|---------------|
| Retención de datos (local) | 72 horas | Herramienta de emergencia, no un archivo histórico |
| Retención de datos (nube) | 14 días | Cubre el 100% de los casos documentados de supervivencia en terremotos |
| Umbral de alerta | >70% puntaje compuesto | Dispara alerta prioritaria a todos los clientes |
| Obsolescencia de fuente | 10 minutos | La fuente se excluye del cálculo si no envía datos nuevos |
| Ventana máxima de supervivencia | 14 días | Literatura científica: promedio máx. 6.8 días, máximo documentado 14 días |

---

## Seguridad

- **Red local aislada (Air-Gapped)** — sin tráfico a la nube salvo configuración explícita
- **SQLCipher** — base de datos encriptada en reposo
- **Autenticación por Token PSK** — los dispositivos MQTT se autentican con claves compaginadas
- **GPS como PII** — las coordenadas se encriptan en tránsito y en reposo
- **Sin PII en la nube** — la nube almacena únicamente coordenadas del centro de la zona, nunca trayectorias GPS individuales

---

## Stack Tecnológico

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

## Proyectos Relacionados

| Proyecto | Descripción |
|----------|-------------|
| [Lookitry](https://github.com/depper-IA/lookitry-showcase) | SaaS de prueba virtual con IA · Next.js · Supabase |
| [kommo-mcp](https://github.com/depper-IA/kommo-mcp) | Servidor MCP para Kommo CRM · Python · OAuth2 |
| [Sammy](https://github.com/depper-IA/sammy) | Asistente de Telegram con IA · TypeScript · SQLite |
| [Rendertry](https://github.com/depper-IA/Rendertry) | Visualizador de personalización automotriz · Vanilla JS |
| [WilkieDevs](https://github.com/depper-IA/WilkieDevs) | Plataforma de automatización web · Chatbot de IA |

---

## Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo [LICENSE](LICENSE) para más detalles.

---

<div align="center">

*Desarrollado desde Cali, Colombia — para quien lo necesite.*

</div>
