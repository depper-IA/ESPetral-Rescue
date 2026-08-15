/// <reference types="vite/client" />

/**
 * Identificador del build (hora de compilación), inyectado por Vite.
 *
 * Se muestra en la interfaz para poder confirmar de un vistazo qué versión
 * está corriendo el dispositivo: la PWA tiene service worker y puede seguir
 * sirviendo un bundle cacheado tras un despliegue, lo que ya causó
 * diagnósticos erróneos en campo.
 */
declare const __BUILD_ID__: string;
