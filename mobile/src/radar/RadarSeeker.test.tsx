/**
 * Tests del componente RadarSeeker — indicador de tendencia de proximidad
 * por RSSI real (Requisito 19: reemplazo del barrido 360° fabricado).
 *
 * Cubre:
 * - La función pura computeProximityTrend (clasificación de tendencia a
 *   partir de un historial de RSSI ascendente/descendente/estable, y el
 *   caso "sin datos").
 * - Integración en el componente: estado "SIN DATOS DE SEÑAL" cuando no
 *   hay alertas con rssi, y que ya no se renderiza el canvas circular del
 *   barrido eliminado (solo debe quedar el canvas del espectrograma).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RadarSeeker, computeProximityTrend } from './RadarSeeker';
import type { ZoneAlert } from '../sync/sync-engine';

afterEach(() => cleanup());

// --- computeProximityTrend (lógica pura) ---

describe('computeProximityTrend — clasificación de tendencia por EMA de RSSI', () => {
  it('reporta "no_data" cuando el historial está vacío', () => {
    const result = computeProximityTrend([]);
    expect(result.trend).toBe('no_data');
    expect(result.currentRssi).toBeNull();
  });

  it('reporta "stable" con una sola lectura (sin base de comparación)', () => {
    const result = computeProximityTrend([-65]);
    expect(result.trend).toBe('stable');
    expect(result.currentRssi).toBe(-65);
  });

  it('reporta "approaching" cuando el RSSI sube (se vuelve menos negativo)', () => {
    // Historial cronológico: señal débil y estable, luego un salto fuerte.
    const result = computeProximityTrend([-80, -80, -80, -60]);
    expect(result.trend).toBe('approaching');
    expect(result.currentRssi).toBe(-60);
  });

  it('reporta "receding" cuando el RSSI baja (se vuelve más negativo)', () => {
    const result = computeProximityTrend([-60, -60, -60, -85]);
    expect(result.trend).toBe('receding');
    expect(result.currentRssi).toBe(-85);
  });

  it('reporta "stable" cuando el cambio está dentro de la banda muerta (±1.5 dB)', () => {
    const result = computeProximityTrend([-65, -65, -65, -66]);
    expect(result.trend).toBe('stable');
    expect(result.currentRssi).toBe(-66);
  });
});

// --- Integración con el componente ---

function makeAlert(overrides: Partial<ZoneAlert> = {}): ZoneAlert {
  return {
    zone_id: 'zone-a',
    motion_probability: 0.5,
    timestamp: '2024-01-15T10:30:00Z',
    // Recién recibida por defecto: el filtro de nodos activos usa este campo.
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('RadarSeeker — indicador de proximidad', () => {
  it('muestra "SIN DATOS DE SEÑAL" cuando no hay alertas', () => {
    render(<RadarSeeker alerts={[]} />);
    expect(screen.getByText(/SIN DATOS DE SEÑAL/i)).toBeInTheDocument();
  });

  it('muestra "SIN DATOS DE SEÑAL" cuando hay alertas pero ninguna trae rssi', () => {
    render(<RadarSeeker alerts={[makeAlert(), makeAlert({ zone_id: 'zone-b' })]} />);
    expect(screen.getByText(/SIN DATOS DE SEÑAL/i)).toBeInTheDocument();
  });

  it('muestra el valor de RSSI y la tendencia "ACERCÁNDOSE" cuando la señal se fortalece', () => {
    // alerts llega con la más reciente primero (unshift), como lo produce SyncEngine.
    const alerts: ZoneAlert[] = [
      makeAlert({ rssi: -60, timestamp: '2024-01-15T10:00:03Z' }),
      makeAlert({ rssi: -80, timestamp: '2024-01-15T10:00:02Z' }),
      makeAlert({ rssi: -80, timestamp: '2024-01-15T10:00:01Z' }),
      makeAlert({ rssi: -80, timestamp: '2024-01-15T10:00:00Z' }),
    ];
    render(<RadarSeeker alerts={alerts} />);
    // Nota: el mismo valor de RSSI puede repetirse en la lista de nodos
    // (dato real crudo) y en el indicador de tendencia — se identifica el
    // indicador de tendencia por su data-testid para evitar ambigüedad.
    expect(screen.getByTestId('rssi-trend-value')).toHaveTextContent('-60 dBm');
    expect(screen.getByText(/ACERCÁNDOSE/i)).toBeInTheDocument();
  });

  it('muestra la tendencia "ALEJÁNDOSE" cuando la señal se debilita', () => {
    const alerts: ZoneAlert[] = [
      makeAlert({ rssi: -85, timestamp: '2024-01-15T10:00:03Z' }),
      makeAlert({ rssi: -60, timestamp: '2024-01-15T10:00:02Z' }),
      makeAlert({ rssi: -60, timestamp: '2024-01-15T10:00:01Z' }),
      makeAlert({ rssi: -60, timestamp: '2024-01-15T10:00:00Z' }),
    ];
    render(<RadarSeeker alerts={alerts} />);
    expect(screen.getByTestId('rssi-trend-value')).toHaveTextContent('-85 dBm');
    expect(screen.getByText(/ALEJÁNDOSE/i)).toBeInTheDocument();
  });

  it('nunca renderiza un encabezado con el emoji de radar prohibido', () => {
    render(<RadarSeeker alerts={[]} />);
    expect(screen.getByText(/BUSCADOR TÁCTICO RADAR/i)).toBeInTheDocument();
    expect(screen.queryByText(/🎯/)).not.toBeInTheDocument();
  });

  it('renderiza un único canvas (el espectrograma waterfall) — sin el barrido radial circular', () => {
    const { container } = render(<RadarSeeker alerts={[]} />);
    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(1);
  });
});

// --- Eliminación del panel de "triangulación" fabricado ---

describe('RadarSeeker — sin panel de triangulación/distancia fabricada', () => {
  it('no renderiza el título del panel de triangulación eliminado', () => {
    render(<RadarSeeker alerts={[]} />);
    expect(screen.queryByText(/TRIANGULACIÓN/i)).not.toBeInTheDocument();
  });

  it('no muestra ninguna distancia estimada en metros a partir de RSSI', () => {
    const alerts: ZoneAlert[] = [makeAlert({ rssi: -60, node_id: 'esp32-s3-001' })];
    render(<RadarSeeker alerts={alerts} />);
    expect(screen.queryByText(/metros/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/~\d+(\.\d+)?\s*m\b/i)).not.toBeInTheDocument();
  });

  it('muestra el panel de detección de patrón respiratorio en su lugar', () => {
    render(<RadarSeeker alerts={[]} />);
    expect(screen.getByText(/DETECCIÓN DE PATRÓN RESPIRATORIO/i)).toBeInTheDocument();
  });

  it('indica "SIN TRAMAS CSI" cuando todavía no llegó ninguna trama', () => {
    // Sin tramas no hay nodo del cual acumular: anunciar "acumulando datos"
    // sugeriría que el análisis está en curso cuando no llega nada.
    render(<RadarSeeker alerts={[]} />);
    expect(screen.getByText(/SIN TRAMAS CSI/i)).toBeInTheDocument();
  });
});

describe('RadarSeeker — nodos activos por recencia (regresión: nodos fantasma)', () => {
  /*
   * REGRESIÓN CUBIERTA: el buffer de alertas conserva las últimas 50
   * lecturas sin expirarlas. Cuando a una placa se le graba un `node_id`
   * nuevo en NVS, sus lecturas viejas siguen en el buffer bajo el ID
   * anterior, y la lista mostraba DOS nodos donde solo hay una placa
   * física. En campo eso se lee como cobertura duplicada inexistente.
   */
  it('no lista un node_id cuya última lectura quedó fuera de la ventana de actividad', () => {
    const alerts: ZoneAlert[] = [
      makeAlert({ node_id: 'bebe', rssi: -40, receivedAt: Date.now() }),
      // Identidad anterior de la MISMA placa, ya vencida.
      makeAlert({ node_id: 'node_588C81547344', rssi: -45, receivedAt: Date.now() - 60_000 }),
    ];
    render(<RadarSeeker alerts={alerts} />);

    expect(screen.getByText(/bebe/)).toBeInTheDocument();
    expect(screen.queryByText(/node_588C81547344/)).not.toBeInTheDocument();
  });

  it('lista dos nodos distintos cuando ambos reportaron recientemente', () => {
    const alerts: ZoneAlert[] = [
      makeAlert({ node_id: 'bebe', rssi: -40, receivedAt: Date.now() }),
      makeAlert({ node_id: 'mama', rssi: -55, receivedAt: Date.now() - 2_000 }),
    ];
    render(<RadarSeeker alerts={alerts} />);

    expect(screen.getByText(/bebe/)).toBeInTheDocument();
    expect(screen.getByText(/mama/)).toBeInTheDocument();
  });

  it('ignora alertas sin node_id en vez de inventarles una identidad', () => {
    const alerts: ZoneAlert[] = [makeAlert({ rssi: -50, receivedAt: Date.now() })];
    render(<RadarSeeker alerts={alerts} />);

    expect(screen.queryByText(/esp32-001/)).not.toBeInTheDocument();
    expect(screen.queryByText(/esp32-s3-001/)).not.toBeInTheDocument();
  });
});
