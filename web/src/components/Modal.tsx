import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal (centered) or Sheet (bottom). Closes on backdrop tap / Escape.
 * Focus moves into the dialog on open and returns on close.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  sheet = false,
  labelledBy,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  sheet?: boolean;
  labelledBy?: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement;
    const el = ref.current;
    const focusable = el?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      (previous.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return (
    <div
      className={sheet ? 'overlay' : 'overlay overlay--center'}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        {sheet ? <div className="sheet__handle" aria-hidden="true" /> : null}
        {title ? (
          <h2 className="sheet__title" id={labelledBy}>
            {title}
          </h2>
        ) : null}
        {children}
        {actions ? <div className="sheet__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Sheet(props: Omit<Parameters<typeof Modal>[0], 'sheet'>) {
  return <Modal {...props} sheet />;
}
