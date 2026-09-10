import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';

export type ButtonVariant = 'primary' | 'entrada' | 'saida' | 'danger' | 'neutral' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'big' | 'huge';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  /** Second line (huge buttons). */
  sub?: ReactNode;
  loading?: boolean;
}

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', block = false, extra = ''): string {
  const cls = ['btn', `btn--${variant}`];
  if (size !== 'md') cls.push(`btn--${size}`);
  if (block) cls.push('btn--block');
  if (extra) cls.push(extra);
  return cls.join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  icon,
  sub,
  loading = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, block, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
      {sub ? <span className="btn__sub">{sub}</span> : null}
    </button>
  );
}

/** A router link styled as a button. */
export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  block = false,
  icon,
  className = '',
  children,
  ...rest
}: { to: string; variant?: ButtonVariant; size?: ButtonSize; block?: boolean; icon?: ReactNode; className?: string; children: ReactNode } & Record<
  string,
  unknown
>) {
  return (
    <Link to={to} className={buttonClass(variant, size, block, className)} {...rest}>
      {icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </Link>
  );
}
