import { Link } from 'react-router';

/** Header bell with the unread count (test id `alerts-badge`). */
export function AlertsBadge({ unread }: { unread: number | null }) {
  return (
    <Link to="/alertas" className="alerts-badge" aria-label={unread ? `${unread} alerta(s) não lido(s)` : 'Alertas'} data-testid="alerts-badge" data-unread={unread ?? 0}>
      <span aria-hidden="true">🔔</span>
      {unread ? <span className="alerts-badge__count">{unread > 99 ? '99+' : unread}</span> : null}
    </Link>
  );
}
