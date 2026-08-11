/**
 * Diálogo de confirmación para limpiar el registro de ubicaciones.
 * Requiere acción explícita del usuario antes de eliminar datos.
 *
 * Requisitos: 5.4
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { LocationEngine } from './location-engine';

export interface ClearLogDialogProps {
  /** Motor de ubicación cuyo registro se limpiará */
  engine: LocationEngine;
  /** Callback invocado después de limpiar exitosamente */
  onCleared?: () => void;
}

/**
 * Hook que expone el estado y acciones del diálogo de confirmación.
 * Retorna el estado abierto/cerrado, funciones para abrir/cerrar,
 * y la función de confirmación que limpia el registro.
 */
export function useClearLogDialog(engine: LocationEngine, onCleared?: () => void) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const confirm = useCallback(() => {
    engine.clear();
    setIsOpen(false);
    onCleared?.();
  }, [engine, onCleared]);

  return { isOpen, open, close, confirm };
}

/**
 * Componente de diálogo modal para confirmar la eliminación del registro.
 * Presenta botones "Confirmar" y "Cancelar" con touch targets ≥48px.
 * El diálogo captura el foco y bloquea interacción con el fondo.
 */
export function ClearLogDialog({ engine, onCleared }: ClearLogDialogProps) {
  const { isOpen, open, close, confirm } = useClearLogDialog(engine, onCleared);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
      // Enfocar el botón de cancelar por seguridad (acción menos destructiva)
      confirmButtonRef.current?.focus();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  // Manejar cierre nativo del dialog (Escape)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      if (isOpen) close();
    };

    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [isOpen, close]);

  return (
    <>
      <button
        type="button"
        onClick={open}
        style={triggerButtonStyle}
        aria-label="Limpiar registro de ubicaciones"
      >
        Limpiar registro
      </button>

      <dialog
        ref={dialogRef}
        style={dialogStyle}
        aria-labelledby="clear-log-title"
        aria-describedby="clear-log-description"
        aria-modal="true"
      >
        <div style={dialogContentStyle}>
          <h2 id="clear-log-title" style={titleStyle}>
            Confirmar eliminación
          </h2>
          <p id="clear-log-description" style={descriptionStyle}>
            ¿Estás seguro de que deseas eliminar todas las ubicaciones registradas?
            Esta acción no se puede deshacer.
          </p>
          <div style={buttonGroupStyle}>
            <button
              type="button"
              onClick={close}
              style={cancelButtonStyle}
              ref={confirmButtonRef}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirm}
              style={confirmButtonStyle}
            >
              Confirmar
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/* ─── Estilos ─── */

const triggerButtonStyle: React.CSSProperties = {
  minWidth: '48px',
  minHeight: '48px',
  padding: '12px 20px',
  fontSize: '14px',
  fontWeight: 600,
  color: '#fff',
  backgroundColor: '#d32f2f',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  touchAction: 'manipulation',
};

const dialogStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: '12px',
  padding: '0',
  maxWidth: '90vw',
  width: '340px',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
};

const dialogContentStyle: React.CSSProperties = {
  padding: '24px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '18px',
  fontWeight: 700,
  color: '#1a1a1a',
};

const descriptionStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '14px',
  lineHeight: 1.5,
  color: '#444',
};

const buttonGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  marginTop: '8px',
  justifyContent: 'flex-end',
};

const cancelButtonStyle: React.CSSProperties = {
  minWidth: '48px',
  minHeight: '48px',
  padding: '12px 20px',
  fontSize: '14px',
  fontWeight: 600,
  color: '#333',
  backgroundColor: '#e0e0e0',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  touchAction: 'manipulation',
};

const confirmButtonStyle: React.CSSProperties = {
  minWidth: '48px',
  minHeight: '48px',
  padding: '12px 20px',
  fontSize: '14px',
  fontWeight: 600,
  color: '#fff',
  backgroundColor: '#d32f2f',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  touchAction: 'manipulation',
};
