import type { ReactNode } from 'react';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  badge?: ReactNode;
}

/** Horizontal, scrollable tab bar (role="tablist"). */
export function Tabs<K extends string>({ items, value, onChange, ariaLabel = 'Seções' }: { items: TabItem<K>[]; value: K; onChange: (key: K) => void; ariaLabel?: string }) {
  return (
    <div className="tabs no-print" role="tablist" aria-label={ariaLabel}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          className={`tabs__tab${t.key === value ? ' tabs__tab--active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.badge !== undefined && t.badge !== null ? <span className="tabs__badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
