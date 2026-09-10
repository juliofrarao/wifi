/**
 * Notification texts (pt-BR) — spec §6. One rendering per (batch, recipient):
 * the recipient's subset of the batch's events. Texts never include a
 * document number (only "documento conferido pela portaria"). Push bodies
 * name at most 3 children ("+N") through joinNames.
 */
import { EVENT_TYPE_LABELS, type EventType, civilDate, formatCivilDate, formatCode, formatDate, formatTime, joinNames, relationshipLabel } from '@creche/shared';
import type { EventRow } from '../../db/rows.js';
import { escapeHtml, htmlLayout, subjectPrefix } from '../email.js';

export interface Rendered {
  title: string;
  /** In-app feed text and e-mail plain text. */
  body: string;
  /** Short text for push (≤ 3 names). */
  pushBody: string;
  /** E-mail HTML part. */
  html: string;
  /** E-mail subject (with the "[<daycare>]" prefix). */
  subject: string;
  /** Exceptions, conflicts, refusals and revoked cards are highlighted in the feed. */
  highlighted: boolean;
}

export interface DaycareInfo {
  name: string;
  phone: string | null;
  tz: string;
}

export interface AttendanceTemplateInput {
  /** ≥ 1 event, same batch, same type, same person and guard. */
  events: EventRow[];
  daycare: DaycareInfo;
  /** authorization_id → relationship label of the one-off authorization ("vizinha"). */
  authorizationLabels: Map<string, string>;
  /** child_id → occurred_at of the child's check-in on the same civil day (for checkout texts). */
  checkinAt: Map<string, string>;
  /** Denied events whose guardian link is blocked. */
  blockedEventIds: Set<string>;
  /** Instant the sheet was entered by the office, for late backfills (> 3 h). */
  backfilledAt: string | null;
  /** Civil "today" of the daycare when rendering (so past-day texts do not say "hoje"). */
  today?: string;
}

const uniq = (names: string[]) => [...new Set(names)];

function finish(daycare: DaycareInfo, title: string, body: string, pushBody: string, highlighted: boolean): Rendered {
  return {
    title,
    body,
    pushBody,
    subject: `${subjectPrefix(daycare.name)} ${title}`,
    html: htmlLayout(daycare.name, [`<strong>${escapeHtml(title)}</strong>`, escapeHtml(body)]),
    highlighted,
  };
}

/** "Maria Silva (mãe)" | "Ana Souza (vizinha), autorizada por Maria Silva (mãe)" | "Ana Souza (não cadastrada)". */
export function personOf(e: EventRow, authorizationLabels: Map<string, string>): string {
  if (e.guardian_id) {
    const rel = e.guardian_relationship ? relationshipLabel(e.guardian_relationship).toLowerCase() : null;
    return rel ? `${e.guardian_name} (${rel})` : `${e.guardian_name ?? ''}`.trim();
  }
  if (e.authorization_id) {
    const label = authorizationLabels.get(e.authorization_id);
    const who = label ? `${e.person_name} (${label})` : `${e.person_name}`;
    return e.authorized_by_name ? `${who}, autorizada por ${e.authorized_by_name}` : who;
  }
  return `${e.person_name} (não cadastrada)`;
}

/** Short person text for push (no "autorizada por"). */
export function personShort(e: EventRow, authorizationLabels: Map<string, string>): string {
  if (e.guardian_id) return personOf(e, authorizationLabels);
  if (e.authorization_id) {
    const label = authorizationLabels.get(e.authorization_id);
    return label ? `${e.person_name} (${label})` : `${e.person_name}`;
  }
  return `${e.person_name}`;
}

function registeredBy(e: EventRow): string {
  if (e.method === 'auto') return 'Registro automático do sistema.';
  if (e.method === 'manual') return `Registrado por ${e.guard_name} (secretaria).`;
  return `Registrado por ${e.guard_name} (portaria).`;
}

function backfillSuffix(input: AttendanceTemplateInput): string {
  if (!input.backfilledAt) return '';
  return ` Registro lançado às ${formatTime(input.backfilledAt, input.daycare.tz)} pela secretaria.`;
}

function conflictSuffix(events: EventRow[]): string {
  const c = events.find((e) => e.conflict)?.conflict;
  if (!c) return '';
  return c === 'already_present'
    ? ' Atenção: este registro veio da fila da portaria e a criança já constava na creche — confira com a secretaria.'
    : ' Atenção: este registro veio da fila da portaria e a criança já constava como fora — confira com a secretaria.';
}

function entryInfo(input: AttendanceTemplateInput): string {
  const { events, checkinAt, daycare } = input;
  const withEntry = events.filter((e) => checkinAt.has(e.child_id));
  if (withEntry.length === 0) return '';
  const times = uniq(withEntry.map((e) => formatTime(checkinAt.get(e.child_id)!, daycare.tz)));
  const sameDay = !input.today || civilDate(events[0].occurred_at, daycare.tz) === input.today;
  const when = sameDay ? 'hoje' : 'no mesmo dia';
  if (withEntry.length === events.length && times.length === 1) return ` Entrada ${when} às ${times[0]}.`;
  const parts = withEntry.map((e) => `${e.child_name} às ${formatTime(checkinAt.get(e.child_id)!, daycare.tz)}`);
  return ` Entradas ${when}: ${parts.join(', ')}.`;
}

export function renderAttendance(input: AttendanceTemplateInput): Rendered {
  const { events, daycare } = input;
  const first = events[0];
  const names = uniq(events.map((e) => e.child_name));
  const plural = names.length > 1;
  const all = joinNames(names, 10);
  const short = joinNames(names, 3);
  const time = formatTime(first.occurred_at, daycare.tz);
  const date = formatDate(first.occurred_at, daycare.tz);
  const person = personOf(first, input.authorizationLabels);
  const shortPerson = personShort(first, input.authorizationLabels);
  const hasConflict = events.some((e) => e.conflict);

  if (first.type === 'denied') {
    const blocked = input.blockedEventIds.has(first.id);
    const who = first.guardian_id
      ? `${first.guardian_name}${first.guardian_relationship ? ` (${relationshipLabel(first.guardian_relationship).toLowerCase()}${blocked ? ', bloqueado' : ''})` : blocked ? ' (bloqueado)' : ''}`
      : `${first.person_name} (não cadastrada)`;
    const title = `Tentativa de retirada recusada — ${short}`;
    const body = `${who} tentou retirar ${all} às ${time} (${date}). A portaria não liberou.${first.note ? ` Observação: ${first.note}.` : ''} ${registeredBy(first)}`;
    return finish(daycare, title, body, `${who} tentou retirar ${short} às ${time}. A portaria não liberou.`, true);
  }

  if (first.type === 'checkin') {
    const verb = plural ? 'chegaram' : 'chegou';
    const left = plural ? 'deixados' : 'deixado';
    const title = `Entrada — ${short}, ${time}`;
    const body = `${all} ${verb} à creche às ${time} (${date}), ${left} por ${person}. ${registeredBy(first)}${backfillSuffix(input)}${conflictSuffix(events)}`;
    return finish(daycare, title, body, `${short} ${verb} às ${time}, ${left} por ${shortPerson}`, hasConflict);
  }

  // checkout
  if (first.method === 'auto') {
    const title = `Fechamento automático — ${short}`;
    const body = `A saída de ${all} em ${date} não foi registrada pela creche; o registro foi fechado automaticamente às ${time}. Se tiver dúvidas, fale com a secretaria.`;
    return finish(daycare, title, body, `Saída de ${short} em ${date} não registrada — fechada automaticamente`, false);
  }
  const verb = plural ? 'saíram' : 'saiu';
  const overrides = events.filter((e) => e.override);
  if (overrides.length > 0) {
    // The server marks override only on the children that needed it (§4.4): name them when the batch is mixed.
    const ex = overrides[0];
    const doc = ex.document_checked ? ', documento conferido pela portaria' : '';
    const reason = ex.note ? ` Motivo: '${ex.note}'.` : '';
    const phone = daycare.phone ? `: ${daycare.phone}` : '';
    const title = 'ATENÇÃO — retirada fora da lista de autorizados';
    let lead: string;
    if (overrides.length === events.length) {
      const notAllowed = ex.guardian_id ? `${person} — fora da lista de autorizados hoje` : person;
      lead = `${all} ${verb} às ${time} (${date}) com ${notAllowed}${doc}.`;
    } else {
      const exNames = joinNames(uniq(overrides.map((e) => e.child_name)), 10);
      lead = `${all} ${verb} às ${time} (${date}) com ${person}${doc}. Exceção para ${exNames}: ${personShort(ex, input.authorizationLabels)} não consta como autorizada hoje.`;
    }
    const body = `${lead}${reason} ${registeredBy(first)}${backfillSuffix(input)}${conflictSuffix(events)} Se você não reconhece esta retirada, ligue agora para a creche${phone}.`;
    return finish(daycare, title, body, `ATENÇÃO: ${short} ${verb} às ${time} com ${shortPerson}. Se não reconhece, ligue para a creche.`, true);
  }
  const title = `Saída registrada — ${short}`;
  const body = `${all} ${verb} da creche às ${time} (${date}) com ${person}.${entryInfo(input)} ${registeredBy(first)}${backfillSuffix(input)}${conflictSuffix(events)}`;
  return finish(daycare, title, body, `${short} ${verb} às ${time} com ${shortPerson}`, hasConflict);
}

export interface VoidTemplateInput {
  event: EventRow;
  voidedByName: string;
  reason: string;
  daycare: DaycareInfo;
}

export function renderVoid(input: VoidTemplateInput): Rendered {
  const { event, daycare } = input;
  const kind = EVENT_TYPE_LABELS[event.type as EventType].toLowerCase();
  const time = formatTime(event.occurred_at, daycare.tz);
  const date = formatDate(event.occurred_at, daycare.tz);
  const title = `Registro cancelado — ${event.child_name}`;
  const body = `O registro de ${kind} de ${event.child_name} às ${time} (${date}) foi cancelado por ${input.voidedByName} (motivo: ${input.reason}).`;
  const highlighted = !!event.override || !!event.conflict || event.type === 'denied';
  return finish(daycare, title, body, `Registro de ${kind} de ${event.child_name} às ${time} cancelado`, highlighted);
}

export interface GuardianAddedInput {
  childName: string;
  guardianName: string;
  relationship: string;
  validUntil: string | null;
  daycare: DaycareInfo;
}

export function renderGuardianAdded(i: GuardianAddedInput): Rendered {
  const rel = relationshipLabel(i.relationship).toLowerCase();
  const until = i.validUntil ? `, até ${formatCivilDate(i.validUntil).slice(0, 5)}` : '';
  const title = `Nova pessoa autorizada — ${i.childName}`;
  const body = `Nova pessoa autorizada a retirar ${i.childName}: ${i.guardianName} (${rel})${until}. Se você não reconhece esta pessoa, fale com a creche.`;
  return finish(i.daycare, title, body, `Nova pessoa autorizada a retirar ${i.childName}: ${i.guardianName} (${rel})${until}.`, false);
}

export interface AuthorizationAddedInput {
  childName: string;
  creatorName: string;
  /** Relationship label of the creator ("Mãe") or null for the office. */
  creatorRelationshipLabel: string | null;
  personName: string;
  relationshipLabel: string;
  validFrom: string;
  validUntil: string;
  today: string;
  daycare: DaycareInfo;
}

export function renderAuthorizationAdded(i: AuthorizationAddedInput): Rendered {
  const creator = `${i.creatorName} (${i.creatorRelationshipLabel ? i.creatorRelationshipLabel.toLowerCase() : 'secretaria'})`;
  const dd = (civil: string) => formatCivilDate(civil).slice(0, 5);
  const period =
    i.validFrom === i.validUntil ? (i.validFrom === i.today ? 'hoje' : `em ${dd(i.validFrom)}`) : `de ${dd(i.validFrom)} a ${dd(i.validUntil)}`;
  const title = `Autorização de retirada — ${i.childName}`;
  const body = `${creator} autorizou ${i.personName} (${i.relationshipLabel}) a retirar ${i.childName} ${period}.`;
  return finish(i.daycare, title, body, body, false);
}

export interface CredentialRevokedInput {
  code: string | null;
  /** Child name when the card belongs to a child (guardians of the child are notified). */
  childName: string | null;
  daycare: DaycareInfo;
}

export function renderCredentialRevoked(i: CredentialRevokedInput): Rendered {
  const card = i.code ? `A carteirinha ${formatCode(i.code)}` : 'A carteirinha (etiqueta NFC)';
  const owner = i.childName ? ` de ${i.childName}` : '';
  const title = 'Carteirinha cancelada';
  const body = `${card}${owner} foi cancelada pela creche. Se precisar de uma nova, fale com a secretaria.`;
  return finish(i.daycare, title, body, `${card}${owner} foi cancelada pela creche.`, true);
}

export function renderSystem(title: string, body: string, daycare: DaycareInfo): Rendered {
  return finish(daycare, title, body, body.length > 140 ? `${body.slice(0, 137)}…` : body, false);
}
