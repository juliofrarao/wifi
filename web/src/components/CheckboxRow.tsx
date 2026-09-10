import type { ReactNode } from 'react';

export type CheckboxTone = 'default' | 'entrada' | 'saida' | 'danger';

/**
 * A whole-row checkbox (≥ 56 px tall). `hideBox` renders the row without the
 * checkbox (single child case) while keeping the same layout.
 */
export function CheckboxRow({
  checked,
  onChange,
  title,
  sub,
  status,
  statusTone,
  leading,
  trailing,
  tone = 'default',
  disabled = false,
  hideBox = false,
  testId,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  title: ReactNode;
  sub?: ReactNode;
  status?: ReactNode;
  statusTone?: 'present' | 'out' | 'danger';
  leading?: ReactNode;
  trailing?: ReactNode;
  tone?: CheckboxTone;
  disabled?: boolean;
  hideBox?: boolean;
  testId?: string;
}) {
  const cls = ['checkrow', tone !== 'default' ? `checkrow--${tone}` : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className={cls}
      data-testid={testId}
      onClick={() => {
        if (!disabled && onChange) onChange(!checked);
      }}
    >
      {hideBox ? null : (
        <span className="checkrow__box" aria-hidden="true">
          {checked ? '✓' : ''}
        </span>
      )}
      {leading}
      <span className="checkrow__body">
        <span className="checkrow__title">{title}</span>
        {sub ? <span className="checkrow__sub">{sub}</span> : null}
        {status ? <span className={`checkrow__status${statusTone ? ` checkrow__status--${statusTone}` : ''}`}>{status}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

/** Simple labelled checkbox (settings, "documento conferido"). */
export function SimpleCheckbox({
  checked,
  onChange,
  label,
  required = false,
  testId,
  tone = 'default',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  required?: boolean;
  testId?: string;
  tone?: CheckboxTone;
}) {
  return (
    <CheckboxRow
      checked={checked}
      onChange={onChange}
      tone={tone}
      testId={testId}
      title={
        <span className="small">
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </span>
      }
    />
  );
}
