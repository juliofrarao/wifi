import type { ReactNode } from 'react';

export type BannerKind = 'info' | 'warn' | 'danger' | 'success';

const ICONS: Record<BannerKind, string> = { info: 'ℹ️', warn: '⚠️', danger: '⛔', success: '✅' };

export function Banner({
  kind = 'info',
  children,
  actions,
  icon,
  onClick,
  className = '',
  role,
  ...rest
}: {
  kind?: BannerKind;
  children: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode | false;
  onClick?: () => void;
  className?: string;
  role?: string;
} & Record<`data-${string}`, string | undefined>) {
  const cls = ['banner', `banner--${kind}`, onClick ? 'banner--tap' : '', className].filter(Boolean).join(' ');
  const content = (
    <>
      {icon === false ? null : (
        <span className="banner__icon" aria-hidden="true">
          {icon ?? ICONS[kind]}
        </span>
      )}
      <span className="banner__body">
        {children}
        {actions ? <span className="banner__actions">{actions}</span> : null}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} {...rest}>
        {content}
      </button>
    );
  }
  return (
    <div className={cls} role={role ?? (kind === 'danger' ? 'alert' : 'status')} {...rest}>
      {content}
    </div>
  );
}
