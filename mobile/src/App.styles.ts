/**
 * Estilos inline del componente App, extraídos a un módulo propio para
 * mantener App.tsx por debajo del umbral de refactorización de 600 líneas
 * (REGLAS_IMPORTANTES.md sección 5.1).
 *
 * Escala z-index semántica de la app (mobile/src):
 *   1000  - controles internos de Leaflet (biblioteca externa, fuera de
 *           nuestro control; ver mobile/src/location/MapView.tsx)
 *   2000  - .cali-sync-bar-fixed: barra de sync fija en la parte superior
 *           del viewport (Fix 4). Prioridad baja: cede espacio al banner
 *           de alerta cuando este está activo.
 *   2100  - .cali-knock-alert-banner: banner de alerta de golpe fijo
 *           (Fix 1). Máxima prioridad de la app: siempre debe ganar
 *           frente a cualquier otro elemento fijo/superpuesto.
 *   10000 - toast de confirmación de portapapeles (mobile/src/location/
 *           share-location.ts). Es transitorio y se ancla al borde
 *           inferior del viewport, por lo que no compite en pantalla con
 *           el banner/la barra superior; se documenta aquí para que quede
 *           registrada la escala completa.
 */
export const appStyles = `
  .cali-app {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 720px;
    margin: 0 auto;
    padding: 16px;
    color: #1a1a1a;
    background: #fff;
  }

  .cali-header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e0e0e0;
  }
  .cali-header h1 {
    margin: 0 0 4px 0;
    font-size: 24px;
  }
  .cali-tagline {
    margin: 0 0 12px 0;
    color: #555;
    font-size: 14px;
  }

  .cali-sync-indicator {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  .cali-sync-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .cali-sync-connected { background: #e6f4ea; color: #1e7a3a; }
  .cali-sync-connecting { background: #fff4e5; color: #a8540c; }
  .cali-sync-disconnected { background: #f0f0f0; color: #555; }
  .cali-sync-offline { background: #fde7e9; color: #b3243a; }

  /* Fix 4: barra de sync fija en la parte superior del viewport, visible
     independientemente del scroll. Cede prioridad visual al banner de
     alerta de golpe (z-index menor, ver escala arriba). */
  .cali-sync-bar-fixed {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2000;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 6px 12px;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
    box-sizing: border-box;
  }

  .cali-section {
    margin-bottom: 24px;
    padding: 16px;
    background: #fafafa;
    border-radius: 8px;
    border: 1px solid #eee;
  }
  .cali-section h2 {
    margin: 0 0 8px 0;
    font-size: 18px;
  }
  .cali-section h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
  }
  .cali-section-meta {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #555;
  }
  .cali-section-footnote {
    margin: 12px 0 0 0;
    font-size: 12px;
    color: #888;
    font-style: italic;
  }

  /* Fix 3: jerarquía visual real entre secciones. La detección acústica es
     la sección más crítica (golpe = posible víctima) y recibe el
     tratamiento más pesado. GPS y Acciones son de menor criticidad
     relativa y se aligeran para crear contraste. Mapa y Alertas quedan en
     el tratamiento medio (baseline de .cali-section) para no competir
     visualmente con la sección de audio. Nunca se usa border-left/right
     como acento de color (anti-patrón prohibido en este proyecto). */
  .cali-gps-section,
  .cali-actions-section {
    background: transparent;
    border: none;
    padding: 12px 0;
  }

  .cali-audio-section {
    background: #f5f5f5;
    border: 2px solid #1a1a1a;
    padding: 20px;
  }
  .cali-audio-section h2 {
    font-size: 20px;
  }

  .cali-label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 6px;
  }
  .cali-input {
    width: 100%;
    padding: 12px 16px;
    font-size: 16px;
    border: 1px solid #ccc;
    border-radius: 6px;
    margin-bottom: 12px;
    min-height: 48px;
    box-sizing: border-box;
  }

  .cali-button {
    min-height: 48px;
    min-width: 48px;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 600;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    background: #f0f0f0;
    color: #1a1a1a;
    touch-action: manipulation;
  }
  .cali-button:hover:not(:disabled) {
    background: #e5e5e5;
  }
  .cali-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cali-button-primary {
    background: #1976d2;
    color: #fff;
  }
  .cali-button-primary:hover:not(:disabled) {
    background: #155fa0;
  }
  .cali-button-warn {
    background: #b35900;
    color: #fff;
  }
  .cali-button-warn:hover:not(:disabled) {
    background: #8f4300;
  }
  .cali-button-danger {
    background: #d32f2f;
    color: #fff;
  }
  .cali-button-danger:hover:not(:disabled) {
    background: #b71c1c;
  }

  .cali-actions-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .cali-error {
    margin: 8px 0 0 0;
    padding: 8px 12px;
    background: #fde7e9;
    color: #b3243a;
    border-radius: 4px;
    font-size: 14px;
  }

  .cali-rms-meter {
    width: 100%;
    height: 8px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  /* La barra ocupa el ancho completo y se escala horizontalmente vía
     transform. Animar 'width' provocaba recálculo de layout en cada frame
     mientras el audio está activo; 'transform' se compone en GPU. */
  .cali-rms-bar {
    height: 100%;
    width: 100%;
    background: #4caf50;
    transform-origin: left center;
    transition: transform 100ms ease-out;
  }
  .cali-rms-readout {
    margin: 0 0 12px 0;
    font-size: 12px;
    color: #666;
  }

  .cali-visualizers {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 12px 0;
  }
  .cali-waveform-canvas,
  .cali-spectrum-canvas {
    width: 100%;
    background: #0a0a0a;
    border-radius: 4px;
    display: block;
  }
  .cali-waveform-canvas { height: 80px; }
  .cali-spectrum-canvas { height: 100px; }

  .cali-knock-status {
    margin-top: 12px;
    padding: 12px;
    border-radius: 4px;
    background: #f5f5f5;
    font-size: 14px;
  }
  .cali-knock-line {
    margin: 0 0 4px 0;
    font-size: 14px;
  }
  .cali-knock-last-pattern {
    margin: 6px 0 0 0;
    font-size: 13px;
    color: #444;
  }
  /* Refuerzo local no crítico: el estado activo se comunica de forma
     dominante vía el banner fijo (.cali-knock-alert-banner). Aquí solo se
     marca el contenedor local con un borde, sin animación ni fondo rojo,
     para no competir visualmente con el banner. */
  .cali-knock-status[data-active='true'] {
    border: 2px solid #b71c1c;
  }

  /* Fix 1: banner de alerta de golpe. Fijo en la parte superior del
     viewport, ancho completo, con fondo sólido (no rgba compuesto) para
     garantizar contraste >= 4.5:1 con texto blanco en cualquier condición
     de fondo. Ver escala z-index al inicio de este archivo. */
  .cali-knock-alert-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2100;
    padding: 14px 16px;
    background: #b71c1c;
    color: #fff;
    text-align: center;
    font-weight: 700;
    font-size: 22px;
    letter-spacing: 0.3px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    animation: cali-alert-pulse-banner 0.6s ease-in-out infinite alternate;
    box-sizing: border-box;
  }
  .cali-knock-alert-banner-detail {
    margin-top: 4px;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: normal;
  }
  @keyframes cali-alert-pulse-banner {
    from { background: #b71c1c; }
    to { background: #8f1010; }
  }

  .cali-alerts-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .cali-alert-item {
    padding: 8px 12px;
    background: #fff4e5;
    border: 1px solid #f57c00;
    border-radius: 4px;
    margin-bottom: 6px;
    font-size: 14px;
  }

  .cali-debug-panel {
    margin-top: 12px;
    padding: 12px;
    background: #1a1a2e;
    color: #e0e0e0;
    border-radius: 4px;
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
  .cali-debug-panel-title {
    font-weight: bold;
    margin-bottom: 8px;
    color: #a0a0ff;
  }
  .cali-debug-row {
    display: flex;
    justify-content: space-between;
  }
  .cali-debug-divider {
    border-top: 1px solid #444;
    margin: 8px 0;
  }
  .cali-debug-panel[data-active='true'] {
    border: 2px solid #ff5252;
  }
  .cali-debug-toggle {
    font-size: 12px;
    padding: 4px 8px;
    margin-left: 8px;
  }

  /* Fix 5: prefers-reduced-motion. Toda animación/transición declarada en
     este archivo debe tener su contraparte sin movimiento. */
  @media (prefers-reduced-motion: reduce) {
    .cali-knock-alert-banner {
      animation: none;
    }
    .cali-rms-bar {
      transition: none;
    }

  }
`;
