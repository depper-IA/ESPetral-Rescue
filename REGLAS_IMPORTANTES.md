# Reglas de Implementacion - CALI Rescue System
**RESPONDE SIEMPRE EN ESPANOL**

---

## 0. PROTOCOLO DE ARRANQUE (CRITICO)

**AL INICIAR CADA CONVERSACION:**
1. Leer SIEMPRE `REGLAS_IMPORTANTES.md` (este archivo)
2. Leer `AGENTS.md` para el contexto del proyecto y arquitectura
3. Leer `.kiro/specs/cali-rescue-system/` para requirements, design y tasks
4. Solo despues proceder con la conversacion

**RAZON**: Evitar perder tiempo preguntando o sugiriendo cosas que ya estan establecidas o documentadas.

---

## 0b. Documentacion Viva (Regla de Sincronicidad)

**TODA VEZ que se realicen cambios estructurales en la arquitectura, componentes base, o diseno, es OBLIGATORIO:**
1. Mantener actualizados los archivos: `REGLAS_IMPORTANTES.md` y `AGENTS.md`.
2. Estos documentos deben reflejar inmediatamente la realidad del sistema. Los documentos nunca deben quedar obsoletos.

**REGLA DE ORO: NO ELIMINAR informacion tecnica que siga siendo valida o funcional. Solo se debe incluir la informacion que falta o se actualiza, manteniendo el historial y contexto previo.**

---

## 1. Reglas de Git

- **Auto-commit**: DESPUES de cada tarea significativa, hacer commit automaticamente con mensaje descriptivo (conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `style:`, `chore:`, etc.)
- **Auto-push**: NO hacer push automatico. Hacer push solo cuando el codigo compila y tests pasan, o por autorizacion del usuario.
- **NO hacer deploy** sin autorizacion explicita del usuario.
- **NUNCA agregar Co-Authored-By** ni atribuciones de IA en los commits.

---

## 2. Gestion Segura de Dependencias (MANDATORIO)

**ALERTA DE SEGURIDAD:** Se han detectado multiples ataques de cadena de suministro (Supply Chain Attacks) masivos en el registro oficial de NPM. Estos ataques inyectan malware para robar credenciales, secretos de entorno (.env) y llaves SSH.

### 2.1 Prohibicion Absoluta de NPM
- **REGLA DE ORO**: Esta **ESTRICTAMENTE PROHIBIDO** ejecutar `npm install`, `npm update`, `npm run`, o cualquier comando `npm` en cualquier parte del proyecto (local, servidor o agentes).
- **Razon**: El cliente oficial de NPM es vulnerable a la ejecucion de scripts maliciosos en la fase de pre-instalacion.

### 2.2 Uso Obligatorio de PNPM
- Para toda gestion de paquetes, se debe usar unicamente **`pnpm`**.
- El lockfile `pnpm-lock.yaml` debe estar trackeado en git.
- **Comandos permitidos**:
  - `pnpm install`
  - `pnpm add [package]`
  - `pnpm add -D [package]` (dev dependencies)
  - `pnpm run [script]`
  - `pnpm build`
  - `pnpm test`
- **Comandos PROHIBIDOS**:
  - `npm install` / `npm i`
  - `npm run`
  - `npm update`
  - `npx` (usar `pnpm dlx` en su lugar)

---

## 3. Arquitectura del Proyecto

### 3.1 Estructura de Tres Componentes
Este proyecto tiene tres componentes independientes:

| Componente | Directorio | Stack | Descripcion |
|-----------|-----------|-------|-------------|
| Mobile App (PWA) | `mobile/` | React + Vite + vite-plugin-pwa | PWA offline-first, servida desde backend |
| Backend | `backend/` | Node.js + TypeScript + pnpm | MQTT broker, scoring engine, dashboard, serve mobile |
| Firmware | `firmware/` | C + ESP-IDF | ESP32-C6 CSI motion detection |

### 3.2 Restricciones por Componente

**Mobile App (PWA React):**
- React + Vite con `vite-plugin-pwa` (Workbox)
- Se reescribe DESDE CERO (el HTML anterior se descarta)
- Build estatico servido desde el backend Express (misma red local)
- Offline-first: PWA con service worker, precaching de assets
- Touch targets minimo 48x48px
- Fuentes minimo 14px body, 12px metadata
- UI completamente en espanol
- Componentes separados: AudioEngine, LocationEngine, MapView, SyncEngine
- pnpm como gestor de paquetes (npm PROHIBIDO)

**Backend:**
- TypeScript obligatorio
- pnpm como gestor de paquetes (npm PROHIBIDO)
- SQLite con SQLCipher para datos en reposo
- MQTT via Aedes
- Express para HTTP/dashboard
- Datos expiran a las 72 horas

**Firmware (ESP32):**
- C con ESP-IDF framework
- Configuracion via NVS (non-volatile storage)
- Buffer circular para lecturas offline
- Consumo promedio <80mA

---

## 4. Blindaje de Ingenieria & Programacion Defensiva

### 4.1 Programacion Defensiva (Backend TypeScript)
- **Optional Chaining (?.)**: Obligatorio en TODOS los accesos a datos de MQTT, WebSocket u objetos dinamicos.
- **Fallbacks de Renderizado**: Siempre proveer valores por defecto (`|| ''`, `?? []`) en datos de entrada.
- **Validacion de mensajes MQTT**: Todo payload debe validarse contra schema antes de procesarlo.

### 4.2 Programacion Defensiva (Mobile App)
- **Graceful degradation**: Si una API no esta disponible (vibration, Web Share, geolocation), mostrar fallback, no crashear.
- **localStorage checks**: Verificar disponibilidad antes de escribir. Operar en memoria si no hay storage.

### 4.3 Gestion de Secretos — PROHIBIDO Hardcodear
- **REGLA ABSOLUTA**: NUNCA se escriben credenciales, API keys, tokens, PSK keys, contraseñas, ni claves privadas literales en el codigo, scripts, documentacion o tests.
- Todo secreto se lee exclusivamente del entorno:
  - Node / TypeScript: `process.env.NOMBRE_VARIABLE`
  - ESP32: NVS storage (nunca en el codigo fuente)
- Si falta una variable critica en el entorno, el sistema debe FALLAR explicitamente en lugar de continuar con valores por defecto inseguros.
- Los valores reales viven SOLO en `.env` (el cual esta gitignoreado). En el repositorio se mantiene unicamente `.env.example` con placeholders.

### 4.4 Seguridad de Red
- Este sistema opera en red local air-gapped (sin internet)
- Toda comunicacion usa TLS/WSS
- Autenticacion por PSK (pre-shared key) para ESP32
- Sin PII: coordenadas GPS son el dato mas sensible, encriptadas en reposo
- Datos se auto-purgan a las 72 horas

---

## 5. Regla de Refactorizacion por Tamano de Archivo (CRITICO)

### 5.1 Umbral de 600 Lineas
- Cuando cualquier archivo de codigo (`.ts`, `.tsx`, `.js`, `.jsx`, `.c`, `.h`) supere las **600 lineas**, DEBE comenzar a refactorizarse en modulos mas pequenos.
- No hay excepciones — la app movil ahora es React con componentes separados.

### 5.2 Protocolo de Refactorizacion
Cuando un archivo supere las 600 lineas:
1. **Identificar modulos extractables:**
   - Funciones de utilidad (helpers, validators)
   - Interfaces/tipos TypeScript
   - Configuraciones estaticas
   - Middleware separado
2. **Crear archivos separados** bajo rutas semanticas como `src/`, `src/scoring/`, `src/mqtt/`, `src/types/`, etc.
3. **Mantener cohesion logica:** No dividir de forma aleatoria; extraer solo lo que tenga sentido semantico e independiente.

### 5.3 Deteccion de Codigo Muerto
Al trabajar en cualquier archivo, se debe:
1. Identificar funciones, imports, variables que no se esten utilizando.
2. Notificar al usuario antes de proceder con su eliminacion con el formato:
   ```
   [CODIGO MUERTO DETECTADO]
   Archivo: X
   Lineas: Y-Z
   Tipo: [funcion/variable/import]
   Razon: [por que es codigo muerto]
   Recomendacion: [borrar/archivar]
   ```

---

## 6. Regla Anti-Duplicacion de Codigo (OBLIGATORIO)

- **Verificacion Obligatoria ANTES de Crear:**
  - ANTES de crear cualquier funcion, clase, modulo o servicio, buscar por nombre o funcionalidad similar en el codebase.
  - Si ya existe codigo identico o similar, reutilizarlo o unificarlo. No crear duplicados innecesarios.
  - Si la nueva implementacion es indudablemente mejor, reemplazar la anterior por completo y actualizar sus referencias.

---

## 7. Testing

### 7.1 Backend
- Unit tests con Vitest (o Jest) para:
  - Scoring engine (property-based con fast-check)
  - MQTT message validation
  - Color mapping
  - Buffer logic
- Ejecutar con: `pnpm test`

### 7.2 Firmware
- Unity test framework para logica en C
- Tests de buffer circular, backoff, LED state machine

### 7.3 Mobile App (React)
- Tests con Vitest para logica de negocio (hooks, engines)
- Property-based tests con fast-check para knock detection, scoring, sync batching
- Ejecutar con: `cd mobile && pnpm test`

---

## 8. Convencion de Commits

Formato: `tipo(scope): descripcion breve en espanol`

Scopes validos:
- `backend` — servidor Node.js, MQTT, scoring, dashboard
- `movil` — rescate_cali.html (PWA)
- `firmware` — ESP32 C code
- `docs` — documentacion, specs, AGENTS.md
- `infra` — configuracion, CI, Docker

Ejemplos:
```
feat(backend): implementar motor de puntuacion compuesta
fix(movil): manejar localStorage lleno sin crashear
feat(firmware): agregar backoff exponencial en reconexion MQTT
docs: actualizar AGENTS.md con arquitectura backend
chore(backend): agregar pnpm lockfile
refactor(movil): reescribir app desde cero con arquitectura mejorada
```

---

## 9. Reglas de Estilo y Presentacion

- **PROHIBIDO usar emojis** en cualquier interfaz, componente, documento, README, commits o comunicacion de este proyecto.
- Usar iconos SVG inline en la app movil cuando se necesiten indicadores visuales.
- Los READMEs y documentos usan texto plano, listas y tablas. Sin emojis decorativos.

---

## 10. Dependencias Pinneadas (Seguridad)

- Al agregar cualquier dependencia con `pnpm add`, usar **versiones exactas** (no rangos):
  - CORRECTO: `pnpm add express@4.18.2`
  - INCORRECTO: `pnpm add express` (instala latest, potencialmente inseguro)
- Si no se conoce la version exacta, instalar y luego verificar que el lockfile quede trackeado.
- Preferir paquetes well-known y activamente mantenidos. Si un nombre de paquete parece sospechoso o podria ser typosquatting, reportar al usuario antes de instalar.

---

## 11. Validacion Pre-Push (MANDATORIO)

Antes de hacer `git push` o antes de declarar una tarea como completada:

**Backend:**
```bash
cd backend && pnpm build && pnpm test
```

**Mobile App (React):**
```bash
cd mobile && pnpm build && pnpm test
```

**Firmware:**
- Verificar que el proyecto compila con `idf.py build` (si ESP-IDF esta disponible)
- Si no hay toolchain local, al menos verificar que el codigo C compila sin errores de sintaxis

---

## 12. Regla de Idioma (CRITICO)

**Regla general: TODO en espanol, EXCEPTO el codigo fuente.**

| Elemento | Idioma | Ejemplo |
|----------|--------|---------|
| Variables, funciones, clases, interfaces | Ingles | `scoringEngine`, `motionProbability` |
| Keywords del lenguaje | Ingles (obligatorio por TypeScript/C) | `const`, `function`, `struct` |
| Comentarios en codigo | Espanol | `// Calcula la probabilidad compuesta` |
| Commits | Espanol | `feat(backend): implementar motor de puntuacion` |
| Documentacion (README, AGENTS.md, specs) | Espanol | — |
| UI copy en la app movil | Espanol | "Escucha Acustica", "Registrar Ubicacion" |
| Comunicacion con el usuario | Espanol | — |
| Nombres de archivos/directorios | Ingles | `backend/`, `scoring-engine.ts` |
| Mensajes de error al usuario final | Espanol | "No se pudo obtener la ubicacion" |

---

## 13. Entorno de Desarrollo

- **OS**: Windows
- **Shell**: cmd / PowerShell
- **Node.js**: requerido para backend
- **pnpm**: gestor de paquetes obligatorio
- **ESP-IDF**: requerido para firmware (puede no estar instalado aun)
- **Git**: control de versiones
- **Sin CI/CD** por ahora (herramienta de emergencia, velocidad > procesos)

---

**Ultima actualizacion:** 2026-08-11 - CALI Rescue System / pnpm / Node.js + ESP-IDF + Single-file PWA
