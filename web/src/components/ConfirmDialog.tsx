import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button, type ButtonVariant } from './Button';
import { TextArea } from './TextField';

/**
 * Confirmation dialog with an optional required reason (used by "Cancelar
 * registro"). `onConfirm` receives the reason (empty string when not asked).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Voltar',
  variant = 'danger',
  reason,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  /** Ask for a reason with this label and minimum length. */
  reason?: { label: string; minLength: number; placeholder?: string };
  onConfirm: (reason: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setBusy(false);
      setError(null);
    }
  }, [open]);
  const valid = !reason || text.trim().length >= reason.minLength;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      dismissible={!busy}
      actions={
        <>
          <Button variant="neutral" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            loading={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(text.trim());
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Erro inesperado');
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {reason ? (
        <TextArea
          label={reason.label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reason.placeholder}
          hint={`Mínimo de ${reason.minLength} caracteres`}
          error={error}
          autoFocus
        />
      ) : error ? (
        <div className="field__error" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
