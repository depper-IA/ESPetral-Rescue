/**
 * ESPetral Rescue — Lista de Verificación de Colocación del Nodo
 *
 * Requisito "Node Placement Checklist" (Fase 0, gate de validación
 * csi-vitals-per-node): guía mínima al Rescatista para colocar el nodo
 * ESP32 de forma que se pueda cumplir el objetivo de precisión de
 * ±3 BPM en una observación de 3 minutos.
 *
 * Diseño (D7): la sección con más detalle se auto-expande cuando la
 * confianza de la lectura es baja (< 0.3) o cuando todavía no hay
 * ninguna lectura — pero NUNCA se auto-colapsa. El operador siempre
 * puede expandir/colapsar manualmente.
 */

import { useEffect, useState } from 'react';

/** Umbral de confianza por debajo del cual el checklist se auto-expande. */
const LOW_CONFIDENCE_THRESHOLD = 0.3;

export interface PlacementChecklistProps {
  /** Confianza actual de la estimación de vitales (0.0-1.0). `null`/`undefined` = sin lectura todavía. */
  confidence?: number | null;
}

export function PlacementChecklist({ confidence = null }: PlacementChecklistProps) {
  const startsLowConfidence = confidence === null || confidence === undefined || confidence < LOW_CONFIDENCE_THRESHOLD;
  const [expanded, setExpanded] = useState(startsLowConfidence);

  // Auto-expandir cuando la confianza cae por debajo del umbral — nunca
  // auto-colapsar (D7: la información de colocación nunca se oculta
  // automáticamente, solo el operador puede colapsarla).
  useEffect(() => {
    const lowConfidence = confidence === null || confidence === undefined || confidence < LOW_CONFIDENCE_THRESHOLD;
    if (lowConfidence) {
      setExpanded(true);
    }
  }, [confidence]);

  return (
    <div
      style={{
        background: '#161b22',
        border: '1px solid #21262d',
        borderRadius: '8px',
        padding: '10px 12px',
        marginTop: '12px',
        color: '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ fontSize: '0.75rem', lineHeight: 1.4 }}>
          <strong style={{ display: 'block', marginBottom: '2px', color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Colocación del Nodo
          </strong>
          <span>Distancia 0.5-2 m del tórax, antena orientada al pecho.</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Ocultar detalle de colocación' : 'Mostrar detalle de colocación'}
          style={{
            flexShrink: 0,
            background: '#21262d',
            border: '1px solid #30363d',
            borderRadius: '6px',
            color: '#f8fafc',
            fontSize: '0.7rem',
            padding: '4px 8px',
            cursor: 'pointer',
            minHeight: '32px',
            minWidth: '32px',
          }}
        >
          {expanded ? 'Ocultar' : 'Ver más'}
        </button>
      </div>

      {expanded && (
        <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '0.72rem', color: '#c9d1d9', lineHeight: 1.6 }}>
          <li>Distancia recomendada: 0.5-2 m del tórax de la persona.</li>
          <li>Antena del nodo orientada hacia el pecho.</li>
          <li>Línea de vista directa, o como máximo una barrera delgada de por medio.</li>
          <li>Nodo fijo sobre una superficie estable — no sostenido en la mano.</li>
          <li>Evitar movimiento del operador a menos de 2 m durante la medición.</li>
          <li>Esperar 30 s para obtener la primera estimación confiable.</li>
        </ul>
      )}
    </div>
  );
}
