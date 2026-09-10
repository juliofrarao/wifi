import { relationshipLabel, type AttendanceEventDTO, type ChildStatus } from '@creche/shared';
import type { Formatters } from '../../lib/formatters';

export type StatusTone = 'present' | 'out' | 'stale' | 'inactive';

/** "Maria (mãe)" / "Ana Souza" from an event's actor. */
export function eventActor(ev: Pick<AttendanceEventDTO, 'guardianName' | 'guardianRelationship' | 'personName'> | null): string {
  if (!ev) return '';
  if (ev.guardianName) {
    const rel = ev.guardianRelationship ? relationshipLabel(ev.guardianRelationship).toLowerCase() : '';
    return rel ? `${ev.guardianName} (${rel})` : ev.guardianName;
  }
  return ev.personName ?? '';
}

/**
 * Status line for a guardian's child card (spec §7 "Responsável › Início"):
 *  - "Na creche desde 07:45 · deixado por Maria (mãe)"
 *  - "Fora da creche · saiu 17:30 com João (pai)"
 *  - "Saída de ontem não registrada — fale com a secretaria" (stale, R12)
 *  - "Desligado(a) em DD/MM" (inactive)
 */
export function childStatusText(
  child: { active: boolean; status: ChildStatus; deactivatedAt?: string | null },
  fmt: Formatters
): { text: string; tone: StatusTone } {
  if (!child.active) {
    const when = child.deactivatedAt ? fmt.dayMonth(child.deactivatedAt) : null;
    return { text: when ? `Desligado(a) em ${when}` : 'Desligado(a)', tone: 'inactive' };
  }
  const { status } = child;
  if (status.present && status.stale) {
    return { text: 'Saída de ontem não registrada — fale com a secretaria', tone: 'stale' };
  }
  if (status.present) {
    const since = status.since ?? status.lastEvent?.occurredAt ?? null;
    const sinceText = since ? (fmt.civilOf(since) === fmt.today() ? fmt.time(since) : fmt.relative(since)) : '';
    const who = status.lastEvent?.type === 'checkin' ? eventActor(status.lastEvent) : '';
    return {
      text: `Na creche${sinceText ? ` desde ${sinceText}` : ''}${who ? ` · deixado por ${who}` : ''}`,
      tone: 'present',
    };
  }
  const last = status.lastEvent;
  if (last && last.type === 'checkout') {
    const when = fmt.civilOf(last.occurredAt) === fmt.today() ? fmt.time(last.occurredAt) : fmt.relative(last.occurredAt);
    const who = eventActor(last);
    return { text: `Fora da creche · saiu ${when}${who ? ` com ${who}` : ''}`, tone: 'out' };
  }
  return { text: 'Fora da creche', tone: 'out' };
}
