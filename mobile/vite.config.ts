import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// HTTPS dev certs generated via mkcert for LAN access.
// Regenerate locally with: mkcert 192.168.1.3 localhost
const httpsCert = fs.existsSync(path.resolve(__dirname, '192.168.1.3+1.pem'))
  ? fs.readFileSync(path.resolve(__dirname, '192.168.1.3+1.pem'))
  : undefined;
const httpsKey = fs.existsSync(path.resolve(__dirname, '192.168.1.3+1-key.pem'))
  ? fs.readFileSync(path.resolve(__dirname, '192.168.1.3+1-key.pem'))
  : undefined;

const httpsConfig = httpsCert && httpsKey ? { cert: httpsCert, key: httpsKey } : undefined;

// Proxy /ws to backend ws-relay. Allows the mobile PWA (HTTPS) to talk to
// the backend (HTTP WS relay on 9001) without mixed-content blocks.
const wsRelayProxy = {
  target: 'ws://localhost:9001',
  ws: true,
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/ws/, ''),
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'ESPetral Rescue - Herramienta de Campo',
        short_name: 'ESPetral Rescue',
        description: 'Aplicacion de campo para busqueda y rescate',
        start_url: '/',
        display: 'standalone',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        icons: [
          { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*tile.*\//,
            handler: 'CacheFirst',
            options: { cacheName: 'map-tiles' },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      '/ws': wsRelayProxy,
    },
  },
  preview: {
    host: true,
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      '/ws': wsRelayProxy,
    },
  },
});
