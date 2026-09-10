import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'default' | 'success' | 'danger' | 'warn';

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastContextValue {
  show: (text: string, kind?: ToastKind, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const show = useCallback((text: string, kind: ToastKind = 'default', durationMs = 3500) => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), durationMs);
  }, []);

  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind !== 'default' ? ` toast--${t.kind}` : ''}`} role={t.kind === 'danger' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
