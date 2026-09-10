import type { ReactNode } from 'react';

export function EmptyState({ icon = '📭', title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="empty__title">{title}</div>
      {children ? <p className="small">{children}</p> : null}
      {action ? <div className="mt">{action}</div> : null}
    </div>
  );
}
