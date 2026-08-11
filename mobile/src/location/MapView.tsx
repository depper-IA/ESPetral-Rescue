/**
 * Vista de mapa inline con Leaflet.js para visualizar ubicaciones registradas.
 * Renderiza hasta 200 entradas como marcadores, ajusta el viewport automáticamente,
 * y provee un fallback offline con grilla de coordenadas.
 *
 * Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import L from 'leaflet';
import type { LocationEntry } from './location-engine';

/** Máximo de marcadores visibles en el mapa */
const MAX_MARKERS = 200;

/** Tamaño mínimo de touch target para marcadores (CSS px) */
const TOUCH_TARGET_SIZE = 44;

/** URL de tiles de OpenStreetMap */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Atribución de OpenStreetMap */
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Formatea una marca de tiempo ISO 8601 a formato local legible.
 */
function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Crea un ícono circular con tamaño mínimo de touch target (44×44px).
 */
function createMarkerIcon(): L.DivIcon {
  return L.divIcon({
    className: 'cali-map-marker',
    iconSize: [TOUCH_TARGET_SIZE, TOUCH_TARGET_SIZE],
    iconAnchor: [TOUCH_TARGET_SIZE / 2, TOUCH_TARGET_SIZE / 2],
    popupAnchor: [0, -(TOUCH_TARGET_SIZE / 2)],
    html: `<div class="cali-map-marker-inner"></div>`,
  });
}

/**
 * Genera el contenido HTML del popup para un marcador.
 */
function createPopupContent(entry: LocationEntry): string {
  const timestamp = formatTimestamp(entry.timestamp);
  const note = entry.note || '(sin nota)';
  return `
    <div class="cali-map-popup">
      <p class="cali-map-popup-note">${escapeHtml(note)}</p>
      <p class="cali-map-popup-time">${escapeHtml(timestamp)}</p>
    </div>
  `;
}

/**
 * Escapa HTML para prevenir XSS en contenido de popups.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Props del componente MapView */
export interface MapViewProps {
  /** Entradas de ubicación a renderizar como marcadores */
  entries: LocationEntry[];
  /** Altura del contenedor del mapa en CSS (default: 300px) */
  height?: string;
}

/**
 * Componente de mapa inline usando Leaflet.js.
 * Muestra marcadores para cada LocationEntry y ajusta el viewport
 * para mostrar todos los puntos. Si los tiles no cargan (offline),
 * muestra un canvas con grilla de coordenadas.
 */
export function MapView({ entries, height = '300px' }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const fallbackLayerRef = useRef<L.Layer | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  // Escuchar cambios de conectividad
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Inicializar mapa
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([3.4516, -76.532], 13); // Centro de Cali, Colombia

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      tileLayerRef.current = null;
      fallbackLayerRef.current = null;
    };
  }, []);

  // Gestionar capa de tiles vs fallback offline
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isOffline) {
      // Remover tiles si existen
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current);
        tileLayerRef.current = null;
      }
      // Agregar fallback si no existe
      if (!fallbackLayerRef.current) {
        fallbackLayerRef.current = createOfflineFallbackLayer(map);
      }
    } else {
      // Remover fallback si existe
      if (fallbackLayerRef.current) {
        map.removeLayer(fallbackLayerRef.current);
        fallbackLayerRef.current = null;
      }
      // Agregar tiles si no existen
      if (!tileLayerRef.current) {
        const tileLayer = L.tileLayer(TILE_URL, {
          attribution: TILE_ATTRIBUTION,
          maxZoom: 19,
        });
        tileLayer.addTo(map);
        tileLayerRef.current = tileLayer;

        // Detectar fallo de tiles (caída de red sin evento offline)
        tileLayer.on('tileerror', () => {
          setIsOffline(true);
        });
      }
    }
  }, [isOffline]);

  // Sincronizar marcadores con las entradas
  const syncMarkers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const visibleEntries = entries.slice(0, MAX_MARKERS);
    const currentIds = new Set(visibleEntries.map(e => e.id));
    const markerIcon = createMarkerIcon();

    // Remover marcadores que ya no están en las entradas
    for (const [id, marker] of markersRef.current) {
      if (!currentIds.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
      }
    }

    // Agregar o actualizar marcadores
    for (const entry of visibleEntries) {
      if (!markersRef.current.has(entry.id)) {
        const marker = L.marker([entry.lat, entry.lon], {
          icon: markerIcon,
        });
        marker.bindPopup(createPopupContent(entry), {
          closeOnClick: true,
          maxWidth: 250,
          minWidth: 150,
        });
        marker.addTo(map);
        markersRef.current.set(entry.id, marker);
      }
    }

    // Ajustar viewport para mostrar todos los marcadores
    if (visibleEntries.length > 0) {
      const bounds = L.latLngBounds(
        visibleEntries.map(e => [e.lat, e.lon] as [number, number])
      );
      map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
    }
  }, [entries]);

  useEffect(() => {
    syncMarkers();
  }, [syncMarkers]);

  return (
    <div
      className="cali-map-container"
      style={{ height, width: '100%', position: 'relative' }}
    >
      <div
        ref={containerRef}
        style={{ height: '100%', width: '100%' }}
        role="application"
        aria-label="Mapa de ubicaciones registradas"
      />
      {isOffline && (
        <div className="cali-map-offline-badge" aria-live="polite">
          Sin conexión — modo offline
        </div>
      )}
      <style>{mapStyles}</style>
    </div>
  );
}

/**
 * Crea una capa de fallback offline con canvas y grilla de coordenadas.
 * Muestra líneas de latitud/longitud con etiquetas sobre fondo blanco.
 */
function createOfflineFallbackLayer(map: L.Map): L.Layer {
  const OfflineGridLayer = L.GridLayer.extend({
    createTile(coords: L.Coords): HTMLCanvasElement {
      const tile = document.createElement('canvas');
      const tileSize = this.getTileSize();
      tile.width = tileSize.x;
      tile.height = tileSize.y;

      const ctx = tile.getContext('2d');
      if (!ctx) return tile;

      // Fondo blanco
      ctx.fillStyle = '#f8f9fa';
      ctx.fillRect(0, 0, tile.width, tile.height);

      // Calcular límites geográficos del tile
      const nw = map.unproject(
        L.point(coords.x * tileSize.x, coords.y * tileSize.y),
        coords.z
      );
      const se = map.unproject(
        L.point((coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y),
        coords.z
      );

      const latRange = nw.lat - se.lat;
      const lonRange = se.lng - nw.lng;

      // Determinar intervalo de grilla según nivel de zoom
      let gridInterval = 1; // grados
      if (coords.z >= 14) gridInterval = 0.001;
      else if (coords.z >= 11) gridInterval = 0.01;
      else if (coords.z >= 8) gridInterval = 0.1;
      else if (coords.z >= 5) gridInterval = 0.5;

      ctx.strokeStyle = '#dee2e6';
      ctx.lineWidth = 1;
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#6c757d';

      // Líneas horizontales (latitud)
      const startLat = Math.floor(se.lat / gridInterval) * gridInterval;
      for (let lat = startLat; lat <= nw.lat; lat += gridInterval) {
        const y = ((nw.lat - lat) / latRange) * tile.height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(tile.width, y);
        ctx.stroke();
        ctx.fillText(lat.toFixed(4) + '°', 4, y - 3);
      }

      // Líneas verticales (longitud)
      const startLon = Math.floor(nw.lng / gridInterval) * gridInterval;
      for (let lon = startLon; lon <= se.lng; lon += gridInterval) {
        const x = ((lon - nw.lng) / lonRange) * tile.width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tile.height);
        ctx.stroke();
        ctx.save();
        ctx.translate(x + 3, tile.height - 4);
        ctx.fillText(lon.toFixed(4) + '°', 0, 0);
        ctx.restore();
      }

      // Borde del tile
      ctx.strokeStyle = '#e9ecef';
      ctx.strokeRect(0, 0, tile.width, tile.height);

      return tile;
    },
  });

  const layer = new OfflineGridLayer() as L.GridLayer;
  layer.addTo(map);
  return layer;
}

/** Estilos CSS del mapa embebidos */
const mapStyles = `
  .cali-map-marker {
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .cali-map-marker-inner {
    width: 20px;
    height: 20px;
    background-color: #dc3545;
    border: 3px solid #fff;
    border-radius: 50%;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
    /* El contenedor padre (44x44) asegura el touch target mínimo */
  }

  .cali-map-popup {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .cali-map-popup-note {
    margin: 0 0 4px 0;
    font-size: 14px;
    font-weight: 500;
    color: #212529;
  }

  .cali-map-popup-time {
    margin: 0;
    font-size: 12px;
    color: #6c757d;
  }

  .cali-map-offline-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgba(33, 37, 41, 0.85);
    color: #fff;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 1000;
    pointer-events: none;
  }

  .cali-map-container .leaflet-container {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
`;
