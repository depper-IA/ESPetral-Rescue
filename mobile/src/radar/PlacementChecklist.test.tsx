/**
 * Tests del componente PlacementChecklist — checklist de colocación del
 * nodo ESP32 para monitoreo de signos vitales (Fase 0, gate de
 * validación csi-vitals-per-node).
 *
 * Cubre el requisito "Node Placement Checklist" del spec: presentar al
 * menos distancia recomendada y orientación relativa al cuerpo, y
 * auto-expandirse cuando la confianza de la lectura es baja (< 0.3).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PlacementChecklist } from './PlacementChecklist';

afterEach(() => cleanup());

describe('PlacementChecklist — guía mínima siempre visible', () => {
  it('muestra distancia recomendada y orientación sin necesidad de expandir', () => {
    render(<PlacementChecklist confidence={0.8} />);

    expect(screen.getByText(/0[.,]5.*2\s*m/i)).toBeInTheDocument();
    expect(screen.getByText(/pecho/i)).toBeInTheDocument();
  });
});

describe('PlacementChecklist — expansión manual', () => {
  it('inicia colapsado con confianza alta y expande al hacer click', () => {
    render(<PlacementChecklist confidence={0.8} />);

    // El detalle completo (espera de 30s) no está visible colapsado
    expect(screen.queryByText(/30\s*s/i)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);

    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();
  });

  it('permite colapsar de nuevo tras expandir manualmente', () => {
    render(<PlacementChecklist confidence={0.8} />);

    const toggle = screen.getByRole('button');
    fireEvent.click(toggle); // expandir
    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();

    fireEvent.click(toggle); // colapsar
    expect(screen.queryByText(/30\s*s/i)).not.toBeInTheDocument();
  });
});

describe('PlacementChecklist — auto-expansión por confianza baja (D7)', () => {
  it('inicia expandido cuando confidence < 0.3', () => {
    render(<PlacementChecklist confidence={0.2} />);

    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();
  });

  it('inicia expandido cuando todavía no hay lectura (confidence null/undefined)', () => {
    render(<PlacementChecklist confidence={null} />);

    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();
  });

  it('se auto-expande cuando la confianza cae por debajo de 0.3 tras iniciar alta', () => {
    const { rerender } = render(<PlacementChecklist confidence={0.8} />);
    expect(screen.queryByText(/30\s*s/i)).not.toBeInTheDocument();

    rerender(<PlacementChecklist confidence={0.15} />);

    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();
  });

  it('NO se auto-colapsa cuando la confianza sube después de haberse auto-expandido', () => {
    const { rerender } = render(<PlacementChecklist confidence={0.15} />);
    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();

    rerender(<PlacementChecklist confidence={0.9} />);

    // Sigue expandido — nunca se oculta automáticamente (D7: nunca ocultar)
    expect(screen.getByText(/30\s*s/i)).toBeInTheDocument();
  });
});
