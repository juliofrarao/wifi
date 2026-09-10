/**
 * Fan-out: turns an attendance batch (or an R16 change) into `notifications`
 * rows — one per recipient per channel — that the dispatcher delivers later.
 *
 * Recipients (R8/R9/R16): active guardians with a live, non-blocked link to
 * the child; admins additionally for exceptions, conflicts, refusals and
 * revoked cards. Channels: `inapp` always; `push` when the user has
 * subscriptions; `email` when the user has an e-mail. Check-ins follow the
 * user's `notify_checkin_push` / `notify_checkin_email` preferences.
 * A late backfill (> 3 h) goes only by `inapp` + `email`; automatic closings
 * only by `inapp`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { type NotificationChannel, type NotificationKind, civilDate, relationshipLabel, todayCivil } from '@creche/shared';
import type { Config } from '../../config.js';
import { type Db, all, one, placeholders, run, tx } from '../../db/index.js';
import { getSetting, SETTING_KEYS } from '../../db/settings.js';
import type { AuthorizationWithCreatorRow, EventRow } from '../../db/rows.js';
import { loadAuthorization } from '../../dto/authorizations.js';
import type { AttendanceBatchOptions, Notifier } from './index.js';
import {
  type DaycareInfo,
  type Rendered,
  renderAttendance,
  renderAuthorizationAdded,
  renderCredentialRevoked,
  renderGuardianAdded,
  renderSystem,
  renderVoid,
} from './templates.js';

export interface NotifierDeps {
  db: Db;
  config: Config;
  now: () => Date;
  /** Whether e-mail rows should be created at all (mailer configured). */
  emailEnabled: () => boolean;
  /** Whether push rows should be created at all (VAPID keys present). */
  pushEnabled: () => boolean;
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export interface Recipient {
  id: string;
  name: string;
  email: string | null;
  role: 'admin' | 'guard' | 'guardian';
  notifyCheckinPush: boolean;
  notifyCheckinEmail: boolean;
  pushCount: number;
  /** Children of the batch this recipient is linked to (admins: all). */
  childIds: string[];
}

interface RecipientRow {
  id: string;
  name: string;
  email: string | null;
  role: 'admin' | 'guard' | 'guardian';
  notify_checkin_push: number;
  notify_checkin_email: number;
  push_count: number;
  child_id: string | null;
}

const RECIPIENT_COLUMNS = `u.id, u.name, u.email, u.role, u.notify_checkin_push, u.notify_checkin_email,
  (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS push_count`;

export function daycareInfo(db: Db, config: Config): DaycareInfo {
  return {
    name: getSetting(db, SETTING_KEYS.daycareName) ?? config.daycareName,
    phone: getSetting(db, SETTING_KEYS.daycarePhone),
    tz: config.tz,
  };
}

/** Active guardians with a live, non-blocked link to any of the children, with their child subset. */
export function guardianRecipients(db: Db, childIds: string[], excludeUserIds: string[] = []): Recipient[] {
  if (childIds.length === 0) return [];
  const rows = all<RecipientRow>(
    db,
    `SELECT ${RECIPIENT_COLUMNS}, l.child_id
     FROM child_guardians l JOIN users u ON u.id = l.user_id
     WHERE l.child_id IN (${placeholders(childIds.length)}) AND l.removed_at IS NULL AND l.blocked = 0
       AND u.active = 1 AND u.anonymized_at IS NULL AND u.role = 'guardian'
     ORDER BY u.name, u.id`,
    ...childIds
  );
  const out = new Map<string, Recipient>();
  const excluded = new Set(excludeUserIds);
  for (const r of rows) {
    if (excluded.has(r.id)) continue;
    let rec = out.get(r.id);
    if (!rec) {
      rec = toRecipient(r, []);
      out.set(r.id, rec);
    }
    if (r.child_id && !rec.childIds.includes(r.child_id)) rec.childIds.push(r.child_id);
  }
  return [...out.values()];
}

export function adminRecipients(db: Db, childIds: string[]): Recipient[] {
  const rows = all<RecipientRow>(db, `SELECT ${RECIPIENT_COLUMNS}, NULL AS child_id FROM users u WHERE u.role = 'admin' AND u.active = 1 AND u.anonymized_at IS NULL ORDER BY u.name, u.id`);
  return rows.map((r) => toRecipient(r, [...childIds]));
}

function toRecipient(r: RecipientRow, childIds: string[]): Recipient {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    notifyCheckinPush: r.notify_checkin_push === 1,
    notifyCheckinEmail: r.notify_checkin_email === 1,
    pushCount: r.push_count,
    childIds,
  };
}

export interface ChannelPolicy {
  kind: NotificationKind;
  highlighted: boolean;
  /** Late backfill: inapp + e-mail only. */
  lateBackfill?: boolean;
  /** Automatic closings and similar: inapp only. */
  inappOnly?: boolean;
  /** Quota warnings: never e-mail. */
  noEmail?: boolean;
}

/** Channels a recipient gets for a notification (R8/R9). */
export function channelsFor(deps: Pick<NotifierDeps, 'emailEnabled' | 'pushEnabled'>, r: Recipient, policy: ChannelPolicy): NotificationChannel[] {
  const channels: NotificationChannel[] = ['inapp'];
  if (policy.inappOnly) return channels;
  const routineCheckin = policy.kind === 'checkin' && !policy.highlighted && r.role === 'guardian';
  const wantsPush = !routineCheckin || r.notifyCheckinPush;
  const wantsEmail = !routineCheckin || r.notifyCheckinEmail;
  if (!policy.lateBackfill && deps.pushEnabled() && r.pushCount > 0 && wantsPush) channels.push('push');
  // R8: an e-mail row exists whenever the recipient has an e-mail. When SMTP is
  // not configured the dispatcher marks it `skipped` (`email_disabled`) so the
  // office can see what was not delivered — it is never silently dropped.
  if (!policy.noEmail && r.email && wantsEmail) channels.push('email');
  return channels;
}

export interface InsertSpec {
  userId: string;
  kind: NotificationKind;
  batchId: string | null;
  eventId: string | null;
  childIds: string[];
  channels: NotificationChannel[];
  rendered: Rendered;
  dispatchAfter: string;
  now: Date;
}

/**
 * Insert one row per channel. The in-app row goes first so push/e-mail rows
 * can point at it (`/alertas?n=<inappId>`). Rows that would repeat
 * (user, batch, channel) are ignored (unique index) — a batch notifies once.
 */
export function insertNotificationRows(db: Db, spec: InsertSpec): string[] {
  const ids: string[] = [];
  const created = spec.now.toISOString();
  const override = spec.rendered.highlighted ? 1 : 0;
  const childIds = JSON.stringify(spec.childIds);
  const order: NotificationChannel[] = ['inapp', 'push', 'email'];
  let inappId: string | null = null;
  for (const channel of order) {
    if (!spec.channels.includes(channel)) continue;
    const id = randomUUID();
    const body = channel === 'push' ? spec.rendered.pushBody : spec.rendered.body;
    const payload =
      channel === 'push'
        ? { url: `/alertas?n=${inappId ?? id}`, tag: spec.batchId ? `batch:${spec.batchId}` : `notification:${inappId ?? id}`, inappId }
        : channel === 'email'
          ? { html: spec.rendered.html, subject: spec.rendered.subject, inappId }
          : null;
    const res = run(
      db,
      `INSERT OR IGNORE INTO notifications (id, user_id, kind, batch_id, event_id, child_ids, channel, status, title, body, override, payload_json, error, attempts, dispatch_after, read_at, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?)`,
      id,
      spec.userId,
      spec.kind,
      spec.batchId,
      spec.eventId,
      childIds,
      channel,
      spec.rendered.title,
      body,
      override,
      payload ? JSON.stringify(payload) : null,
      spec.dispatchAfter,
      created
    );
    if (res.changes === 0) continue;
    if (channel === 'inapp') inappId = id;
    ids.push(id);
  }
  return ids;
}

/** Live (non-voided) events of a batch, oldest first; ties keep insertion order (the order the guard confirmed). */
export function batchEvents(db: Db, batchId: string): EventRow[] {
  return all<EventRow>(db, `SELECT * FROM attendance_events WHERE batch_id = ? AND voided_at IS NULL ORDER BY occurred_at ASC, created_at ASC, rowid ASC`, batchId);
}

function authorizationLabels(db: Db, events: EventRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = [...new Set(events.map((e) => e.authorization_id).filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  for (const r of all<{ id: string; relationship_label: string }>(db, `SELECT id, relationship_label FROM pickup_authorizations WHERE id IN (${placeholders(ids.length)})`, ...ids)) {
    out.set(r.id, r.relationship_label);
  }
  return out;
}

/** child_id → occurred_at of the child's first non-voided checkin on the same civil day as the checkout. */
function sameDayCheckins(db: Db, events: EventRow[], tz: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'checkout') continue;
    const day = civilDate(e.occurred_at, tz);
    const row = one<{ occurred_at: string }>(
      db,
      `SELECT occurred_at FROM attendance_events WHERE child_id = ? AND type = 'checkin' AND voided_at IS NULL AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT 1`,
      e.child_id,
      e.occurred_at
    );
    if (row && civilDate(row.occurred_at, tz) === day) out.set(e.child_id, row.occurred_at);
  }
  return out;
}

function blockedDenied(db: Db, events: EventRow[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== 'denied' || !e.guardian_id) continue;
    const row = one<{ blocked: number }>(db, 'SELECT blocked FROM child_guardians WHERE child_id = ? AND user_id = ? AND removed_at IS NULL', e.child_id, e.guardian_id);
    if (row?.blocked) out.add(e.id);
  }
  return out;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { db, config } = deps;

  const notifyAttendanceBatch = (batchId: string, opts: AttendanceBatchOptions): void => {
    const events = batchEvents(db, batchId);
    if (events.length === 0) return;
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const childIds = [...new Set(events.map((e) => e.child_id))];
    const kind = events[0].type as NotificationKind;
    const highlighted = events.some((e) => e.override || e.conflict || e.type === 'denied');
    const labels = authorizationLabels(db, events);
    const checkinAt = sameDayCheckins(db, events, config.tz);
    const blocked = blockedDenied(db, events);
    const render = (subset: EventRow[]) =>
      renderAttendance({ events: subset, daycare, authorizationLabels: labels, checkinAt, blockedEventIds: blocked, backfilledAt: opts.backfilledAt ?? null });
    const policy: ChannelPolicy = { kind, highlighted, lateBackfill: !!opts.backfilledAt, inappOnly: !!opts.inappOnly };

    tx(db, () => {
      for (const r of guardianRecipients(db, childIds)) {
        const subset = events.filter((e) => r.childIds.includes(e.child_id));
        if (subset.length === 0) continue;
        insertNotificationRows(db, {
          userId: r.id,
          kind,
          batchId,
          eventId: subset[0].id,
          childIds: [...new Set(subset.map((e) => e.child_id))],
          channels: channelsFor(deps, r, policy),
          rendered: render(subset),
          dispatchAfter: opts.dispatchAfter,
          now,
        });
      }
      if (highlighted && !opts.inappOnly) {
        const rendered = render(events);
        for (const r of adminRecipients(db, childIds)) {
          insertNotificationRows(db, {
            userId: r.id,
            kind,
            batchId,
            eventId: events[0].id,
            childIds,
            channels: channelsFor(deps, r, policy),
            rendered,
            dispatchAfter: opts.dispatchAfter,
            now,
          });
        }
      }
    });
  };

  const eventVoided = (eventId: string, actorUserId: string | null, reason: string): void => {
    const event = one<EventRow>(db, 'SELECT * FROM attendance_events WHERE id = ?', eventId);
    if (!event) return;
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const actor = actorUserId ? one<{ name: string }>(db, 'SELECT name FROM users WHERE id = ?', actorUserId) : null;
    const rendered = renderVoid({ event, voidedByName: actor?.name ?? 'a creche', reason, daycare });
    const highlighted = !!event.override || !!event.conflict || event.type === 'denied';
    // Channels follow the policy of the original kind (a voided routine check-in stays routine).
    const policy: ChannelPolicy = { kind: event.type as NotificationKind, highlighted };
    const recipients = [...guardianRecipients(db, [event.child_id]), ...(highlighted ? adminRecipients(db, [event.child_id]) : [])];
    tx(db, () => {
      for (const r of recipients) {
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'void',
          batchId: null,
          eventId: event.id,
          childIds: [event.child_id],
          channels: channelsFor(deps, r, policy),
          rendered,
          dispatchAfter: now.toISOString(),
          now,
        });
      }
    });
  };

  const guardianAdded = (childId: string, linkUserId: string, _actorUserId: string | null): void => {
    const link = one<{ relationship: string; valid_until: string | null; u_name: string }>(
      db,
      `SELECT l.relationship, l.valid_until, u.name AS u_name FROM child_guardians l JOIN users u ON u.id = l.user_id
       WHERE l.child_id = ? AND l.user_id = ? AND l.removed_at IS NULL`,
      childId,
      linkUserId
    );
    const child = one<{ name: string }>(db, 'SELECT name FROM children WHERE id = ?', childId);
    if (!link || !child) return;
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const rendered = renderGuardianAdded({ childName: child.name, guardianName: link.u_name, relationship: link.relationship, validUntil: link.valid_until, daycare });
    const policy: ChannelPolicy = { kind: 'guardian_added', highlighted: false };
    tx(db, () => {
      for (const r of guardianRecipients(db, [childId], [linkUserId])) {
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'guardian_added',
          batchId: null,
          eventId: null,
          childIds: [childId],
          channels: channelsFor(deps, r, policy),
          rendered,
          dispatchAfter: now.toISOString(),
          now,
        });
      }
    });
  };

  const authorizationAdded = (authorizationId: string, actorUserId: string | null): void => {
    const auth: AuthorizationWithCreatorRow | undefined = loadAuthorization(db, authorizationId);
    if (!auth) return;
    const child = one<{ name: string }>(db, 'SELECT name FROM children WHERE id = ?', auth.child_id);
    if (!child) return;
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const rendered = renderAuthorizationAdded({
      childName: child.name,
      creatorName: auth.c_name,
      creatorRelationshipLabel: auth.c_relationship ? relationshipLabel(auth.c_relationship) : null,
      personName: auth.person_name,
      relationshipLabel: auth.relationship_label,
      validFrom: auth.valid_from,
      validUntil: auth.valid_until,
      today: todayCivil(config.tz, now),
      daycare,
    });
    const policy: ChannelPolicy = { kind: 'authorization_added', highlighted: false };
    const exclude = [auth.created_by, ...(actorUserId ? [actorUserId] : [])];
    tx(db, () => {
      for (const r of guardianRecipients(db, [auth.child_id], exclude)) {
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'authorization_added',
          batchId: null,
          eventId: null,
          childIds: [auth.child_id],
          channels: channelsFor(deps, r, policy),
          rendered,
          dispatchAfter: now.toISOString(),
          now,
        });
      }
    });
  };

  const credentialRevoked = (credentialId: string, _actorUserId: string | null): void => {
    const cred = one<{ owner_type: 'guardian' | 'child'; owner_id: string; code: string | null }>(db, 'SELECT owner_type, owner_id, code FROM credentials WHERE id = ?', credentialId);
    if (!cred) return;
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const policy: ChannelPolicy = { kind: 'credential_revoked', highlighted: true };
    tx(db, () => {
      if (cred.owner_type === 'guardian') {
        const row = one<RecipientRow>(db, `SELECT ${RECIPIENT_COLUMNS}, NULL AS child_id FROM users u WHERE u.id = ? AND u.active = 1 AND u.anonymized_at IS NULL`, cred.owner_id);
        if (!row) return;
        const r = toRecipient(row, []);
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'credential_revoked',
          batchId: null,
          eventId: null,
          childIds: [],
          channels: channelsFor(deps, r, policy),
          rendered: renderCredentialRevoked({ code: cred.code, childName: null, daycare }),
          dispatchAfter: now.toISOString(),
          now,
        });
        return;
      }
      const child = one<{ name: string }>(db, 'SELECT name FROM children WHERE id = ?', cred.owner_id);
      if (!child) return;
      const rendered = renderCredentialRevoked({ code: cred.code, childName: child.name, daycare });
      for (const r of guardianRecipients(db, [cred.owner_id])) {
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'credential_revoked',
          batchId: null,
          eventId: null,
          childIds: [cred.owner_id],
          channels: channelsFor(deps, r, policy),
          rendered,
          dispatchAfter: now.toISOString(),
          now,
        });
      }
    });
  };

  const adminAlert = (title: string, body: string, options: { noEmail?: boolean } = {}): void => {
    const now = deps.now();
    const daycare = daycareInfo(db, config);
    const rendered = renderSystem(title, body, daycare);
    const policy: ChannelPolicy = { kind: 'system', highlighted: false, noEmail: options.noEmail };
    tx(db, () => {
      for (const r of adminRecipients(db, [])) {
        insertNotificationRows(db, {
          userId: r.id,
          kind: 'system',
          batchId: null,
          eventId: null,
          childIds: [],
          channels: channelsFor(deps, r, policy),
          rendered,
          dispatchAfter: now.toISOString(),
          now,
        });
      }
    });
  };

  return { attendanceBatch: notifyAttendanceBatch, eventVoided, guardianAdded, authorizationAdded, credentialRevoked, adminAlert };
}
