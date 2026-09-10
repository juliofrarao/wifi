import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EVENT_TYPE_LABELS, METHOD_LABELS, relationshipLabel, type AttendanceEventDTO } from '@creche/shared';
import { useFormat } from '../lib/format';
import { Button } from './Button';

/** "Maria Silva (mãe)" / "Ana Souza (não cadastrada)". */
export function eventWho(ev: AttendanceEventDTO): string {
  if (ev.guardianName) {
    const rel = ev.guardianRelationship ? relationshipLabel(ev.guardianRelationship).toLowerCase() : '';
    return rel ? `${ev.guardianName} (${rel})` : ev.guardianName;
  }
  if (ev.personName) return `${ev.personName} (não cadastrada)`;
  return '';
}

export function eventBadgeClass(type: AttendanceEventDTO['type']): string {
  return type === 'checkin' ? 'badge badge--ok' : type === 'checkout' ? 'badge badge--saida' : 'badge badge--danger';
}

/**
 * One attendance event as a list row. `childLink` renders the child name as
 * a link (admin lists); `onVoid` shows the "Cancelar" action.
 */
export function EventRow({
  event: ev,
  childLink = false,
  showChild = true,
  onVoid,
  trailing,
  testId,
  showDocument = false,
}: {
  event: AttendanceEventDTO;
  childLink?: boolean;
  showChild?: boolean;
  onVoid?: (ev: AttendanceEventDTO) => void;
  trailing?: ReactNode;
  testId?: string;
  showDocument?: boolean;
}) {
  const fmt = useFormat();
  const who = eventWho(ev);
  const flagged = ev.override || ev.conflict || ev.type === 'denied';
  return (
    <div className={`list-item${flagged && !ev.voidedAt ? ' list-item--danger' : ''}${ev.voidedAt ? ' list-item--voided' : ''}`} data-testid={testId}>
      <span className={eventBadgeClass(ev.type)}>{EVENT_TYPE_LABELS[ev.type]}</span>
      <span className="list-item__body">
        {showChild ? (
          <span className="list-item__title">{childLink ? <Link to={`/admin/criancas/${ev.childId}`}>{ev.childName}</Link> : ev.childName}</span>
        ) : null}
        <span className="list-item__sub">
          {fmt.dateTime(ev.occurredAt)}
          {who ? ` · ${who}` : ''}
          {ev.authorizedByName ? ` · ${ev.authorizedByName}` : ''}
          {' · '}
          {METHOD_LABELS[ev.method]} · {ev.guardName}
        </span>
        <span className="row">
          {ev.override ? <span className="badge badge--danger">exceção</span> : null}
          {ev.conflict ? <span className="badge badge--warn">conflito: {ev.conflict === 'already_present' ? 'já estava na creche' : 'já estava fora'}</span> : null}
          {ev.queued ? <span className="badge">da fila</span> : null}
          {ev.documentChecked ? <span className="badge badge--info">documento conferido</span> : null}
          {showDocument && ev.personDocument ? <span className="tiny muted">doc.: {ev.personDocument}</span> : null}
          {ev.voidedAt ? (
            <span className="badge badge--danger">
              cancelado {fmt.dateTime(ev.voidedAt)}
              {ev.voidReason ? `: ${ev.voidReason}` : ''}
            </span>
          ) : null}
          {ev.note ? <span className="tiny muted">{ev.note}</span> : null}
        </span>
      </span>
      {trailing}
      {onVoid && !ev.voidedAt ? (
        <Button variant="ghost" size="sm" onClick={() => onVoid(ev)} aria-label={`Cancelar registro de ${ev.childName}`}>
          Cancelar
        </Button>
      ) : null}
    </div>
  );
}
