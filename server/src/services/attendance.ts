/**
 * Attendance: the batch algorithm of POST /attendance/events (spec §5,
 * R1–R15), cancellation (§4.8), backfill (§4.9), the "today" summary, the
 * events query with role rules (R10) and the CSV export (§10).
 *
 * One batch = one transaction. Rejected items never interrupt the others;
 * notifications are created inside the same transaction (pending rows held
 * for NOTIFY_HOLD_SECONDS) so a crash never leaves events without alerts.
 */
import { randomUUID } from 'node:crypto';
import {
  type AttendanceEventDTO,
  type BackfillBody,
  type ChildStatus,
  type CreateEventsBody,
  type CreateEventsResult,
  type EventItemResult,
  type EventsQuery,
  type EventType,
  type Method,
  type TodaySummary,
  type ErrorCode,
  METHOD_LABELS,
  addDays,
  civilDate,
  formatDate,
  formatTime,
  relationshipLabel,
  todayCivil,
} from '@creche/shared';
import type { Config } from '../config.js';
import { type Db, all, one, placeholders, run, tx } from '../db/index.js';
import type { AuthorizationWithCreatorRow, ChildRow, CredentialRow, EventRow, LinkWithUserRow, UserRow } from '../db/rows.js';
import { loadAuthorization } from '../dto/authorizations.js';
import { childrenGate, getChild, linkAllowsPickupNow, liveLink } from '../dto/children.js';
import { EVENT_ORDER, eventToDto } from '../dto/events.js';
import { audit } from '../lib/audit.js';
import { ApiError, ERROR_MESSAGES } from '../lib/errors.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, dayEndIso, dayRange, isValidCivilDate, normalizeIso, plusMsIso } from '../lib/time.js';
import { toCsv } from './csv.js';
import type { Notifier } from './notifications/index.js';
import { childStatus, deriveStatus, presentChildren } from './status.js';

export interface AttendanceCtx {
  db: Db;
  config: Config;
  notifier: Notifier;
  filesSecret: string;
}

export interface Actor {
  user: UserRow;
  ip: string | null;
  now: Date;
}

/** Queued events may carry a device time within [now − 7 d, now + 2 min] (R6). */
export const QUEUED_PAST_WINDOW_MS = 7 * DAY_MS;
export const QUEUED_FUTURE_WINDOW_MS = 2 * MINUTE_MS;
/** R5: same type/child/person/guard within 60 s is a double tap. */
export const DOUBLE_TAP_MS = 60_000;
/** Guards may cancel their events for 24 h (admins always). */
export const GUARD_VOID_WINDOW_MS = 24 * HOUR_MS;
/** Backfills older than this notify by inapp + e-mail only. */
export const LATE_BACKFILL_MS = 3 * HOUR_MS;
/** Guards see at most 7 days of history (R10). */
export const GUARD_HISTORY_DAYS = 7;
export const CSV_MAX_DAYS = 366;

export const AUTO_PERSON_NAME = 'Sistema';

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export type NewEventRow = Omit<EventRow, 'voided_at' | 'voided_by' | 'void_reason'>;

export function insertEventRow(db: Db, row: NewEventRow): EventRow {
  run(
    db,
    `INSERT INTO attendance_events (id, client_id, batch_id, child_id, child_name, type, guardian_id, guardian_name, guardian_relationship,
       person_name, person_document, document_checked, authorization_id, authorized_by_name, guard_id, guard_name, method, credential_id,
       override, conflict, queued, directory_at, note, occurred_at, created_at, voided_at, voided_by, void_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    row.id,
    row.client_id,
    row.batch_id,
    row.child_id,
    row.child_name,
    row.type,
    row.guardian_id,
    row.guardian_name,
    row.guardian_relationship,
    row.person_name,
    row.person_document,
    row.document_checked,
    row.authorization_id,
    row.authorized_by_name,
    row.guard_id,
    row.guard_name,
    row.method,
    row.credential_id,
    row.override,
    row.conflict,
    row.queued,
    row.directory_at,
    row.note,
    row.occurred_at,
    row.created_at
  );
  return { ...row, voided_at: null, voided_by: null, void_reason: null };
}

export function getEvent(db: Db, id: string): EventRow | undefined {
  return one<EventRow>(db, 'SELECT * FROM attendance_events WHERE id = ?', id);
}

/** "Maria (mãe)" / "Direção (secretaria)" — snapshot of who granted a one-off authorization. */
export function authorizedByNameOf(auth: AuthorizationWithCreatorRow): string {
  const rel = auth.c_relationship ? relationshipLabel(auth.c_relationship).toLowerCase() : 'secretaria';
  return `${auth.c_name} (${rel})`;
}

/** 23:59:59.999 (daycare zone) of the civil day an instant falls in — R1 automatic closing. */
export function autoCloseInstant(entryIso: string, tz: string): string {
  const day = civilDate(entryIso, tz);
  return new Date(new Date(dayEndIso(day, tz)).getTime() + 999).toISOString();
}

/** Status of a child as of an instant (used by backfill, whose occurred_at is arbitrary). */
export function statusAt(db: Db, childId: string, atIso: string, tz: string): ChildStatus {
  const last = one<EventRow>(
    db,
    `SELECT * FROM attendance_events WHERE child_id = ? AND voided_at IS NULL AND type IN ('checkin','checkout') AND occurred_at <= ?
     ORDER BY ${EVENT_ORDER} LIMIT 1`,
    childId,
    atIso
  );
  const status = deriveStatus(last, { now: new Date(atIso), tz, admin: true });
  return status;
}

// ---------------------------------------------------------------------------
// POST /attendance/events
// ---------------------------------------------------------------------------

export interface CreateEventsOptions {
  /** Admin backfill: arbitrary occurred_at (≤ now), method manual, R1 evaluated at occurred_at. */
  backfill?: boolean;
}

const rejected = (item: { clientId: string; childId: string }, code: ErrorCode, message?: string, currentStatus?: ChildStatus): EventItemResult => ({
  clientId: item.clientId,
  childId: item.childId,
  status: 'rejected',
  error: { code, message: message ?? ERROR_MESSAGES[code], ...(currentStatus ? { currentStatus } : {}) },
});

function resolveOccurredAt(body: CreateEventsBody, now: Date, queued: boolean, backfill: boolean, warnings: string[], tz: string): string {
  const nowIso = now.toISOString();
  if (backfill) {
    if (!body.occurredAt) throw new ApiError('OCCURRED_AT_INVALID', 'Informe o horário do registro');
    const iso = normalizeIso(body.occurredAt);
    if (iso > nowIso) throw new ApiError('OCCURRED_AT_INVALID', 'O horário não pode estar no futuro');
    return iso;
  }
  if (!queued) return nowIso; // R6: live events always use the server clock
  if (!body.occurredAt) {
    warnings.push('Registro da fila sem horário do aparelho: usado o horário do servidor');
    return nowIso;
  }
  const device = new Date(body.occurredAt).getTime();
  if (Number.isNaN(device)) {
    warnings.push('Horário do aparelho inválido: usado o horário do servidor');
    return nowIso;
  }
  const min = now.getTime() - QUEUED_PAST_WINDOW_MS;
  const max = now.getTime() + QUEUED_FUTURE_WINDOW_MS;
  if (device < min || device > max) {
    warnings.push(`Horário do aparelho (${formatDate(body.occurredAt, tz)} ${formatTime(body.occurredAt, tz)}) fora da janela aceita: usado o horário do servidor`);
    return nowIso;
  }
  return new Date(device).toISOString();
}

function findDoubleTap(db: Db, childId: string, type: EventType, guardId: string, guardianId: string | null, personName: string | null, occurredAt: string): EventRow | undefined {
  const t = new Date(occurredAt).getTime();
  return one<EventRow>(
    db,
    `SELECT * FROM attendance_events
     WHERE child_id = ? AND type = ? AND guard_id = ? AND voided_at IS NULL
       AND ((? IS NOT NULL AND guardian_id = ?) OR (? IS NULL AND guardian_id IS NULL AND person_name = ?))
       AND occurred_at > ? AND occurred_at < ?
     ORDER BY occurred_at DESC LIMIT 1`,
    childId,
    type,
    guardId,
    guardianId,
    guardianId,
    guardianId,
    personName,
    new Date(t - DOUBLE_TAP_MS).toISOString(),
    new Date(t + DOUBLE_TAP_MS).toISOString()
  );
}

/** Whether an authorization covers the child at an instant (valid on that civil day, not revoked before it). */
function authorizationCovers(auth: AuthorizationWithCreatorRow, childId: string, occurredAt: string, tz: string): boolean {
  if (auth.child_id !== childId) return false;
  const civil = civilDate(occurredAt, tz);
  if (auth.valid_from > civil || auth.valid_until < civil) return false;
  if (auth.revoked_at && auth.revoked_at <= occurredAt) return false;
  return true;
}

export function createEvents(ctx: AttendanceCtx, actor: Actor, body: CreateEventsBody, options: CreateEventsOptions = {}): CreateEventsResult {
  const { db, config } = ctx;
  const tz = config.tz;
  const now = actor.now;
  const nowIso = now.toISOString();
  const backfill = !!options.backfill;
  const queued = !backfill && !!body.queued;
  const isAdmin = actor.user.role === 'admin';
  const warnings: string[] = [];

  return tx(db, () => {
    // 1. Resolve guardian / person / authorization; R15.
    const guardian = body.guardianId ? one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND role = 'guardian'`, body.guardianId) : null;
    if (body.guardianId && !guardian) throw new ApiError('NOT_FOUND', 'Responsável não encontrado');
    const auth = body.authorizationId ? loadAuthorization(db, body.authorizationId) : null;
    if (body.authorizationId && !auth) throw new ApiError('NOT_FOUND', 'Autorização não encontrada');
    const personName = guardian ? null : (body.personName?.trim() || (auth ? auth.person_name : null));
    if (!guardian && !personName) throw new ApiError('VALIDATION', 'Informe o responsável ou o nome da pessoa', { issues: [{ path: 'guardianId', message: 'Informe o responsável ou o nome da pessoa' }] });

    const childIds = body.events.map((e) => e.childId);
    const method: Method = backfill ? 'manual' : body.method;
    let credential: CredentialRow | null = null;
    if (method === 'nfc' || method === 'qr' || method === 'code') {
      if (!body.credentialId) throw new ApiError('VALIDATION', 'Leitura por carteirinha exige credentialId', { issues: [{ path: 'credentialId', message: 'Informe a carteirinha lida' }] });
      credential = one<CredentialRow>(db, 'SELECT * FROM credentials WHERE id = ?', body.credentialId) ?? null;
      if (!credential) throw new ApiError('NOT_FOUND', 'Carteirinha não encontrada');
      const owns =
        (credential.owner_type === 'guardian' && !!guardian && credential.owner_id === guardian.id) || (credential.owner_type === 'child' && childIds.includes(credential.owner_id));
      if (!owns) throw new ApiError('CREDENTIAL_MISMATCH', 'A carteirinha não pertence ao responsável nem às crianças do lote');
    } else if (body.credentialId) {
      throw new ApiError('VALIDATION', `O método "${METHOD_LABELS[method]}" não usa carteirinha (credentialId deve ser nulo)`, { issues: [{ path: 'credentialId', message: 'Deve ser nulo' }] });
    }

    // 2. occurred_at (R6) and batch id.
    const occurredAt = resolveOccurredAt(body, now, queued, backfill, warnings, tz);
    let revokedCardNote: string | null = null;
    let rejectAll: ErrorCode | null = null;
    if (credential && !credential.active) {
      if (!queued) rejectAll = 'CARD_REVOKED'; // R11: live event with a revoked card is rejected
      else if (credential.revoked_at && credential.revoked_at <= occurredAt) {
        revokedCardNote = `carteirinha revogada em ${formatDate(credential.revoked_at, tz).slice(0, 5)} ${formatTime(credential.revoked_at, tz)}`;
      }
    }
    const existingByClient = new Map<string, EventRow>();
    for (const item of body.events) {
      const row = one<EventRow>(db, 'SELECT * FROM attendance_events WHERE client_id = ?', item.clientId);
      if (row) existingByClient.set(item.clientId, row);
    }
    const batchId = existingByClient.size > 0 ? [...existingByClient.values()][0].batch_id : randomUUID();

    const results: EventItemResult[] = [];
    const createdIds: string[] = [];
    const dto = (row: EventRow): AttendanceEventDTO => eventToDto(row, { admin: isAdmin });
    const statusOf = (childId: string): ChildStatus => (backfill ? statusAt(db, childId, occurredAt, tz) : childStatus(db, childId, { now, tz, admin: isAdmin }));

    // 3. Items, in order.
    for (const item of body.events) {
      const existing = existingByClient.get(item.clientId);
      if (existing) {
        results.push({ clientId: item.clientId, childId: item.childId, status: 'duplicate', event: dto(existing) }); // R4
        continue;
      }
      if (rejectAll) {
        results.push(rejected(item, rejectAll));
        continue;
      }
      const child = getChild(db, item.childId);
      if (!child) {
        results.push(rejected(item, 'NOT_FOUND', 'Criança não encontrada'));
        continue;
      }
      if (!child.active) {
        results.push(rejected(item, 'INVALID_STATE', 'Criança desligada'));
        continue;
      }
      // R5 — double tap.
      const dup = findDoubleTap(db, child.id, body.type, actor.user.id, guardian?.id ?? null, personName, occurredAt);
      if (dup) {
        results.push({ clientId: item.clientId, childId: item.childId, status: 'duplicate', event: dto(dup) });
        continue;
      }
      const link: LinkWithUserRow | undefined = guardian ? liveLink(db, child.id, guardian.id) : undefined;
      // Blocked link: pickup is refused even with override; a `denied` event records the refusal; check-in never blocks (R3).
      if (link?.blocked && body.type === 'checkout') {
        results.push(rejected(item, 'GUARDIAN_BLOCKED'));
        continue;
      }
      // R1 — state.
      let conflict: EventRow['conflict'] = null;
      let autoCloseSince: string | null = null;
      if (body.type !== 'denied') {
        const status = statusOf(child.id);
        if (body.type === 'checkin') {
          if (status.present && !status.stale) {
            if (queued) conflict = 'already_present';
            else {
              results.push(rejected(item, 'INVALID_STATE', 'A criança já está na creche', status));
              continue;
            }
          } else if (status.present && status.stale) {
            autoCloseSince = status.since;
          }
        } else if (!status.present) {
          if (queued) conflict = 'already_out';
          else {
            results.push(rejected(item, 'INVALID_STATE', 'A criança não está na creche', status));
            continue;
          }
        } else if (status.stale && !queued && !body.note?.trim()) {
          results.push(rejected(item, 'STALE_PRESENCE', undefined, status));
          continue;
        }
      }
      // R2 — who may pick up (checkout only).
      let override = 0;
      let note = body.note?.trim() || null;
      if (body.type === 'checkout') {
        const civil = civilDate(occurredAt, tz);
        const allowedByLink = !!guardian && !!link && link.u_active === 1 && linkAllowsPickupNow(link, civil);
        const allowedByAuth = !!auth && authorizationCovers(auth, child.id, occurredAt, tz);
        if (!allowedByLink && !allowedByAuth) {
          if (body.override && note && note.length >= 10) override = 1;
          else {
            const reason = guardian
              ? link
                ? link.u_active !== 1
                  ? 'Cadastro do responsável inativo'
                  : !link.can_pickup
                    ? 'Responsável sem permissão para retirar esta criança'
                    : 'Autorização do responsável fora da validade'
                : 'Responsável não vinculado a esta criança'
              : auth
                ? auth.child_id !== child.id
                  ? 'A autorização avulsa é de outra criança'
                  : 'Autorização avulsa fora da validade'
                : 'Pessoa fora da lista de autorizados';
            results.push(rejected(item, 'PICKUP_NOT_ALLOWED', `${reason} — registre uma exceção com motivo`));
            continue;
          }
        }
      }
      if (revokedCardNote) {
        override = 1;
        note = note ? `${note} — ${revokedCardNote}` : revokedCardNote;
      }
      // R1 automatic closing (own batch, inapp-only notification).
      if (autoCloseSince) {
        const autoBatch = randomUUID();
        insertEventRow(db, {
          id: randomUUID(),
          client_id: null,
          batch_id: autoBatch,
          child_id: child.id,
          child_name: child.name,
          type: 'checkout',
          guardian_id: null,
          guardian_name: null,
          guardian_relationship: null,
          person_name: AUTO_PERSON_NAME,
          person_document: null,
          document_checked: 0,
          authorization_id: null,
          authorized_by_name: null,
          guard_id: actor.user.id,
          guard_name: actor.user.name,
          method: 'auto',
          credential_id: null,
          override: 0,
          conflict: null,
          queued: 0,
          directory_at: null,
          note: `Fechamento automático: saída não registrada em ${formatDate(autoCloseSince, tz).slice(0, 5)}`,
          occurred_at: autoCloseInstant(autoCloseSince, tz),
          created_at: nowIso,
        });
        ctx.notifier.attendanceBatch(autoBatch, { dispatchAfter: nowIso, inappOnly: true });
      }
      const useAuth = !!auth && !guardian && auth.child_id === child.id;
      const row = insertEventRow(db, {
        id: randomUUID(),
        client_id: item.clientId,
        batch_id: batchId,
        child_id: child.id,
        child_name: child.name,
        type: body.type,
        guardian_id: guardian?.id ?? null,
        guardian_name: guardian?.name ?? null,
        guardian_relationship: link?.relationship ?? null,
        person_name: guardian ? null : personName,
        person_document: guardian ? null : body.personDocument?.trim() || null,
        document_checked: body.documentChecked ? 1 : 0,
        authorization_id: useAuth ? auth!.id : null,
        authorized_by_name: useAuth ? authorizedByNameOf(auth!) : null,
        guard_id: actor.user.id,
        guard_name: actor.user.name,
        method,
        credential_id: credential?.id ?? null,
        override,
        conflict,
        queued: queued ? 1 : 0,
        directory_at: queued && body.directoryGeneratedAt ? normalizeIso(body.directoryGeneratedAt) : null,
        note,
        occurred_at: occurredAt,
        created_at: nowIso,
      });
      createdIds.push(row.id);
      results.push({ clientId: item.clientId, childId: item.childId, status: 'created', event: dto(row) });
    }

    // 4. Notifications for the batch (pending, held for the undo window).
    if (createdIds.length === 0) return { batchId, undoUntil: null, results, warnings };
    const undoUntil = plusMsIso(now, config.notifyHoldSeconds * 1000);
    const late = backfill && now.getTime() - new Date(occurredAt).getTime() > LATE_BACKFILL_MS;
    ctx.notifier.attendanceBatch(batchId, { dispatchAfter: undoUntil, backfilledAt: late ? nowIso : null });
    if (backfill) {
      audit(db, { id: actor.user.id, name: actor.user.name }, 'attendance.backfill', 'attendance_event', batchId, { type: body.type, occurredAt, created: createdIds.length }, actor.ip, now);
    }
    return { batchId, undoUntil, results, warnings };
  });
}

// ---------------------------------------------------------------------------
// POST /attendance/events/:id/void
// ---------------------------------------------------------------------------

export function voidEvent(ctx: AttendanceCtx, actor: Actor, eventId: string, reason: string): EventRow {
  const { db } = ctx;
  const event = getEvent(db, eventId);
  if (!event) throw new ApiError('NOT_FOUND', 'Registro não encontrado');
  if (event.voided_at) return event; // idempotent (the app retries undo per event)
  const now = actor.now;
  if (actor.user.role !== 'admin' && now.getTime() - new Date(event.created_at).getTime() > GUARD_VOID_WINDOW_MS) {
    throw new ApiError('FORBIDDEN', 'A portaria só pode cancelar registros das últimas 24 horas — fale com a secretaria');
  }
  const nowIso = now.toISOString();
  return tx(db, () => {
    run(db, 'UPDATE attendance_events SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?', nowIso, actor.user.id, reason, event.id);
    audit(db, { id: actor.user.id, name: actor.user.name }, 'event.void', 'attendance_event', event.id, { reason, batchId: event.batch_id, childId: event.child_id, type: event.type }, actor.ip, now);

    const delivered = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM notifications WHERE batch_id = ? AND status = 'sent'`, event.batch_id)?.n ?? 0;
    if (delivered === 0) {
      // Still inside the hold window (or nothing was ever delivered): no alert about this event goes out.
      const pending = all<{ id: string; dispatch_after: string }>(db, `SELECT id, dispatch_after FROM notifications WHERE batch_id = ? AND status = 'pending'`, event.batch_id);
      const remaining = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM attendance_events WHERE batch_id = ? AND voided_at IS NULL', event.batch_id)?.n ?? 0;
      if (remaining === 0) {
        run(db, `UPDATE notifications SET status = 'skipped', error = 'voided' WHERE batch_id = ? AND status = 'pending'`, event.batch_id);
      } else if (pending.length > 0) {
        // Siblings remain: regenerate the pending rows for them, keeping the original hold.
        run(db, `DELETE FROM notifications WHERE batch_id = ? AND status = 'pending'`, event.batch_id);
        ctx.notifier.attendanceBatch(event.batch_id, { dispatchAfter: pending[0].dispatch_after });
      }
    } else {
      // Alerts were delivered: nothing more about this event is sent; the guardians get "Registro cancelado".
      run(
        db,
        `UPDATE notifications SET status = 'skipped', error = 'voided' WHERE batch_id = ? AND status = 'pending' AND child_ids LIKE ?`,
        event.batch_id,
        `%"${event.child_id}"%`
      );
      ctx.notifier.eventVoided(event.id, actor.user.id, reason);
    }
    return getEvent(db, event.id)!;
  });
}

// ---------------------------------------------------------------------------
// POST /attendance/backfill
// ---------------------------------------------------------------------------

export function backfillEvents(ctx: AttendanceCtx, actor: Actor, body: BackfillBody): CreateEventsResult {
  const { db } = ctx;
  interface Group {
    key: string;
    type: 'checkin' | 'checkout';
    guardianId: string | null;
    personName: string | null;
    occurredAt: string;
    note: string | null;
    rows: { clientId: string; childId: string }[];
  }
  const groups = new Map<string, Group>();
  const invalid: EventItemResult[] = [];
  for (const row of body.rows) {
    let occurredAt: string;
    try {
      occurredAt = normalizeIso(row.occurredAt);
    } catch {
      invalid.push(rejected(row, 'OCCURRED_AT_INVALID'));
      continue;
    }
    const note = row.note?.trim() || null;
    const key = `${row.type}|${row.guardianId ?? `p:${row.personName?.trim().toLowerCase()}`}|${occurredAt}|${note ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, type: row.type, guardianId: row.guardianId ?? null, personName: row.guardianId ? null : (row.personName?.trim() ?? null), occurredAt, note, rows: [] };
      groups.set(key, g);
    }
    g.rows.push({ clientId: row.clientId, childId: row.childId });
  }
  const ordered = [...groups.values()].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const results: EventItemResult[] = [...invalid];
  const warnings: string[] = [];
  let batchId: string | null = null;
  let undoUntil: string | null = null;
  tx(db, () => {
    for (const g of ordered) {
      const groupBody: CreateEventsBody = {
        type: g.type,
        guardianId: g.guardianId,
        personName: g.personName,
        method: 'manual',
        credentialId: null,
        // A checkout by an unregistered person on paper is an exception by definition.
        override: g.type === 'checkout' && !g.guardianId,
        note: g.type === 'checkout' && !g.guardianId && (!g.note || g.note.length < 10) ? `${g.note ? `${g.note} — ` : ''}Lançamento da folha de papel pela secretaria` : g.note,
        occurredAt: g.occurredAt,
        queued: false,
        events: g.rows,
      };
      try {
        const res = createEvents(ctx, actor, groupBody, { backfill: true });
        results.push(...res.results);
        warnings.push(...res.warnings);
        if (res.undoUntil) {
          batchId ??= res.batchId;
          undoUntil = undoUntil && undoUntil > res.undoUntil ? undoUntil : res.undoUntil;
        }
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        for (const r of g.rows) results.push(rejected(r, err.code, err.message));
      }
    }
  });
  const order = new Map(body.rows.map((r, i) => [r.clientId, i]));
  results.sort((a, b) => (order.get(a.clientId) ?? 0) - (order.get(b.clientId) ?? 0));
  return { batchId: batchId ?? randomUUID(), undoUntil, results, warnings };
}

// ---------------------------------------------------------------------------
// GET /attendance/today
// ---------------------------------------------------------------------------

export function todaySummary(ctx: AttendanceCtx, now: Date, admin: boolean): TodaySummary {
  const { db, config } = ctx;
  const tz = config.tz;
  const today = todayCivil(tz, now);
  const [start, end] = dayRange(today, today, tz);
  const dtoCtx = { filesSecret: ctx.filesSecret, tz, now };
  const { present, stale } = presentChildren(db, { now, tz, admin });
  const rowsOf = (ids: string[]): ChildRow[] => (ids.length ? all<ChildRow>(db, `SELECT * FROM children WHERE id IN (${placeholders(ids.length)}) ORDER BY class_name, name`, ...ids) : []);
  const count = (type: EventType) =>
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM attendance_events WHERE type = ? AND voided_at IS NULL AND occurred_at >= ? AND occurred_at < ?', type, start, end)?.n ?? 0;
  const events = all<EventRow>(db, `SELECT * FROM attendance_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY ${EVENT_ORDER}`, start, end);
  return {
    date: today,
    presentCount: present.length,
    stalePresentCount: stale.length,
    checkinsToday: count('checkin'),
    checkoutsToday: count('checkout'),
    present: childrenGate(db, rowsOf(present), dtoCtx),
    stale: childrenGate(db, rowsOf(stale), dtoCtx),
    events: events.map((e) => eventToDto(e, { admin })),
  };
}

// ---------------------------------------------------------------------------
// GET /attendance/events
// ---------------------------------------------------------------------------

export interface EventsFilter {
  childId?: string;
  from?: string;
  to?: string;
  type?: EventType;
  includeVoided: boolean;
}

function whereOf(filter: EventsFilter, tz: string): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.childId) {
    clauses.push('child_id = ?');
    params.push(filter.childId);
  }
  if (filter.from) {
    clauses.push('occurred_at >= ?');
    params.push(dayRange(filter.from, filter.from, tz)[0]);
  }
  if (filter.to) {
    clauses.push('occurred_at < ?');
    params.push(dayRange(filter.to, filter.to, tz)[1]);
  }
  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (!filter.includeVoided) clauses.push('voided_at IS NULL');
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function assertCivil(value: string | undefined, field: string): void {
  if (value && !isValidCivilDate(value)) throw new ApiError('VALIDATION', 'Data inválida', { issues: [{ path: field, message: 'Data inválida (use AAAA-MM-DD)' }] });
}

/** Events with the role rules of R10: guards ≤ 7 days, guardians only their (non-blocked) children. */
export function queryEvents(ctx: AttendanceCtx, actor: Actor, query: EventsQuery): { items: AttendanceEventDTO[]; total: number } {
  const { db, config } = ctx;
  const tz = config.tz;
  assertCivil(query.from, 'from');
  assertCivil(query.to, 'to');
  const filter: EventsFilter = { childId: query.childId, from: query.from, to: query.to, type: query.type, includeVoided: !!query.includeVoided };
  const role = actor.user.role;
  if (role === 'guard') {
    const minFrom = addDays(todayCivil(tz, actor.now), -GUARD_HISTORY_DAYS);
    if (!filter.from || filter.from < minFrom) filter.from = minFrom;
    if (filter.to && filter.to < minFrom) return { items: [], total: 0 };
  } else if (role === 'guardian') {
    if (!filter.childId) throw new ApiError('VALIDATION', 'Informe a criança (childId)', { issues: [{ path: 'childId', message: 'Obrigatório' }] });
    const link = liveLink(db, filter.childId, actor.user.id);
    if (!link || link.blocked) throw new ApiError('FORBIDDEN');
  }
  const { where, params } = whereOf(filter, tz);
  const total = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM attendance_events ${where}`, ...params)?.n ?? 0;
  const rows = all<EventRow>(db, `SELECT * FROM attendance_events ${where} ORDER BY ${EVENT_ORDER} LIMIT ? OFFSET ?`, ...params, query.limit, query.offset);
  return { items: rows.map((r) => eventToDto(r, { admin: role === 'admin' })), total };
}

// ---------------------------------------------------------------------------
// GET /attendance/events.csv
// ---------------------------------------------------------------------------

export const CSV_HEADER = [
  'data',
  'hora',
  'tipo',
  'crianca',
  'turma',
  'responsavel',
  'parentesco',
  'pessoa_nao_cadastrada',
  'documento',
  'autorizacao',
  'metodo',
  'excecao',
  'conflito',
  'cancelado',
  'observacao',
  'registrado_por',
  'id_evento',
];

const TYPE_CSV: Record<EventType, string> = { checkin: 'entrada', checkout: 'saida', denied: 'recusa' };
const simNao = (v: boolean) => (v ? 'sim' : 'nao');

export interface CsvFilter {
  from?: string;
  to?: string;
  childId?: string;
}

/** CSV per spec §10: BOM, `;`, CRLF, occurred_at ASC, from/to default today, ≤ 366 days. */
export function eventsCsv(ctx: AttendanceCtx, now: Date, filter: CsvFilter): { csv: string; filename: string } {
  const { db, config } = ctx;
  const tz = config.tz;
  assertCivil(filter.from, 'from');
  assertCivil(filter.to, 'to');
  const today = todayCivil(tz, now);
  const from = filter.from ?? filter.to ?? today;
  const to = filter.to ?? filter.from ?? today;
  if (to < from) throw new ApiError('VALIDATION', 'Data final antes da inicial', { issues: [{ path: 'to', message: 'Data final antes da inicial' }] });
  const span = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS + 1;
  if (span > CSV_MAX_DAYS) throw new ApiError('VALIDATION', `Período máximo de ${CSV_MAX_DAYS} dias`, { issues: [{ path: 'to', message: 'Período muito longo' }] });
  const [start, end] = dayRange(from, to, tz);
  const params: unknown[] = [start, end];
  let where = 'e.occurred_at >= ? AND e.occurred_at < ?';
  if (filter.childId) {
    where += ' AND e.child_id = ?';
    params.push(filter.childId);
  }
  const rows = all<EventRow & { class_name: string | null }>(
    db,
    `SELECT e.*, c.class_name FROM attendance_events e JOIN children c ON c.id = e.child_id WHERE ${where} ORDER BY e.occurred_at ASC, e.created_at ASC, e.id ASC`,
    ...params
  );
  const lines: (string | number | null)[][] = [CSV_HEADER];
  for (const e of rows) {
    lines.push([
      formatDate(e.occurred_at, tz),
      formatTime(e.occurred_at, tz, true),
      TYPE_CSV[e.type],
      e.child_name,
      e.class_name,
      e.guardian_name,
      e.guardian_relationship ? relationshipLabel(e.guardian_relationship) : null,
      e.person_name,
      e.person_document,
      e.authorized_by_name,
      METHOD_LABELS[e.method],
      simNao(e.override === 1),
      simNao(!!e.conflict),
      simNao(!!e.voided_at),
      e.note,
      e.guard_name,
      e.id,
    ]);
  }
  return { csv: toCsv(lines), filename: from === to ? `eventos-${from}.csv` : `eventos-${from}_${to}.csv` };
}
