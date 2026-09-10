/**
 * Notification dispatcher (spec "Despacho de notificações"): every 5 s,
 * pending rows with `dispatch_after ≤ now` and `attempts < 3` are delivered.
 *  - inapp → sent (the feed shows only sent rows);
 *  - push → web-push; 404/410 delete the subscription;
 *  - email → nodemailer with Reply-To = contactEmail; transient errors
 *    (4xx SMTP, network) retry after 60 s / 300 s / 1800 s, permanent ones
 *    fail and are recorded in users.last_email_error. When SMTP_DAILY_LIMIT is
 *    reached, routine e-mails are skipped ('quota'); highlighted ones
 *    (exceptions, conflicts, refusals, revoked cards) still go out and the
 *    admins are warned once per civil day.
 */
import type { FastifyBaseLogger } from 'fastify';
import { type PushPayload, todayCivil } from '@creche/shared';
import type { Config } from '../../config.js';
import { type Db, all, one, run } from '../../db/index.js';
import { getSetting, SETTING_KEYS, setSetting } from '../../db/settings.js';
import type { NotificationRow, PushSubscriptionRow } from '../../db/rows.js';
import { civilDayRange } from '../../lib/time.js';
import { type Mailer, isTransientMailError, subjectPrefix } from '../email.js';
import type { PushService } from '../push.js';
import { createNotifier, daycareInfo } from './fanout.js';

export interface DispatcherDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  push: PushService;
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  now?: () => Date;
}

export interface DispatchSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
}

export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800];
const BATCH_LIMIT = 100;

interface Payload {
  url?: string;
  tag?: string;
  inappId?: string | null;
  html?: string;
  subject?: string;
}

function payloadOf(row: NotificationRow): Payload {
  if (!row.payload_json) return {};
  try {
    return JSON.parse(row.payload_json) as Payload;
  } catch {
    return {};
  }
}

/** E-mails sent today (daycare civil day). */
export function emailsSentToday(db: Db, config: Config, now: Date): number {
  const [start, end] = civilDayRange(todayCivil(config.tz, now), config.tz);
  return one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM notifications WHERE channel = 'email' AND status = 'sent' AND sent_at >= ? AND sent_at < ?`, start, end)?.n ?? 0;
}

function markSent(db: Db, row: NotificationRow, now: Date): void {
  run(db, `UPDATE notifications SET status = 'sent', sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?`, now.toISOString(), row.id);
}

function markSkipped(db: Db, row: NotificationRow, reason: string): void {
  run(db, `UPDATE notifications SET status = 'skipped', error = ?, attempts = attempts + 1 WHERE id = ?`, reason, row.id);
}

function markFailed(db: Db, row: NotificationRow, error: string): void {
  run(db, `UPDATE notifications SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?`, error.slice(0, 300), row.id);
}

/** attempts++ and reschedule; the third failure becomes `failed`. Returns true when it will retry. */
function scheduleRetry(db: Db, row: NotificationRow, error: string, now: Date): boolean {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    run(db, `UPDATE notifications SET status = 'failed', error = ?, attempts = ? WHERE id = ?`, error.slice(0, 300), attempts, row.id);
    return false;
  }
  const backoff = RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
  const next = new Date(now.getTime() + backoff * 1000).toISOString();
  run(db, `UPDATE notifications SET attempts = ?, error = ?, dispatch_after = ? WHERE id = ?`, attempts, error.slice(0, 300), next, row.id);
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function dispatchOnce(deps: DispatcherDeps): Promise<DispatchSummary> {
  const { db, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const summary: DispatchSummary = { processed: 0, sent: 0, failed: 0, skipped: 0, retried: 0 };
  const rows = all<NotificationRow>(
    db,
    `SELECT * FROM notifications WHERE status = 'pending' AND dispatch_after <= ? AND attempts < ? ORDER BY dispatch_after, created_at, id LIMIT ?`,
    nowIso,
    MAX_ATTEMPTS,
    BATCH_LIMIT
  );
  if (rows.length === 0) return summary;

  const notifier = createNotifier({ db, config, now: () => now, emailEnabled: () => deps.mailer.enabled, pushEnabled: () => deps.push.enabled() });
  const daycare = daycareInfo(db, config);
  const replyTo = getSetting(db, SETTING_KEYS.contactEmail);
  let emailsToday = emailsSentToday(db, config, now);
  const today = todayCivil(config.tz, now);

  for (const row of rows) {
    summary.processed++;
    // Re-check: a void may have skipped this row while we were sending the previous ones.
    const fresh = one<NotificationRow>(db, 'SELECT * FROM notifications WHERE id = ?', row.id);
    if (!fresh || fresh.status !== 'pending') continue;
    try {
      if (row.channel === 'inapp') {
        markSent(db, row, now);
        summary.sent++;
        continue;
      }
      const user = one<{ id: string; name: string; email: string | null; active: number }>(db, 'SELECT id, name, email, active FROM users WHERE id = ?', row.user_id);
      if (!user || !user.active) {
        markSkipped(db, row, 'inactive');
        summary.skipped++;
        continue;
      }
      if (row.channel === 'push') {
        const subs = all<PushSubscriptionRow>(db, 'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at', row.user_id);
        if (subs.length === 0) {
          markSkipped(db, row, 'no_subscription');
          summary.skipped++;
          continue;
        }
        const payload = payloadOf(row);
        const message: PushPayload = {
          title: row.title,
          body: row.body,
          url: payload.url ?? `/alertas?n=${payload.inappId ?? row.id}`,
          tag: payload.tag ?? (row.batch_id ? `batch:${row.batch_id}` : `notification:${row.id}`),
          notificationId: payload.inappId ?? row.id,
          kind: row.kind,
          override: row.override === 1,
        };
        let ok = 0;
        let gone = 0;
        let lastError = '';
        for (const sub of subs) {
          const res = await deps.push.send(sub, message);
          if (res.gone) {
            run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
            gone++;
          } else if (res.ok) {
            run(db, 'UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?', nowIso, sub.id);
            ok++;
          } else {
            lastError = res.error ?? 'erro de push';
            run(db, 'UPDATE push_subscriptions SET last_error = ? WHERE id = ?', lastError.slice(0, 300), sub.id);
          }
        }
        if (ok > 0) {
          markSent(db, row, now);
          summary.sent++;
        } else if (gone === subs.length) {
          markSkipped(db, row, 'gone');
          summary.skipped++;
        } else if (scheduleRetry(db, row, lastError || 'erro de push', now)) {
          summary.retried++;
        } else {
          summary.failed++;
        }
        continue;
      }
      // email
      if (!deps.mailer.enabled) {
        markSkipped(db, row, 'email_disabled');
        summary.skipped++;
        continue;
      }
      if (!user.email) {
        markSkipped(db, row, 'no_email');
        summary.skipped++;
        continue;
      }
      if (emailsToday >= config.smtp.dailyLimit && row.override !== 1) {
        markSkipped(db, row, 'quota');
        summary.skipped++;
        if (getSetting(db, SETTING_KEYS.quotaWarnedDay) !== today) {
          setSetting(db, SETTING_KEYS.quotaWarnedDay, today);
          notifier.adminAlert(
            'Limite diário de e-mails atingido',
            `O limite de ${config.smtp.dailyLimit} e-mails por dia (SMTP_DAILY_LIMIT) foi atingido. Alertas de rotina não serão enviados por e-mail até amanhã; exceções continuam sendo enviadas. As notificações no app e por push não são afetadas.`,
            { noEmail: true }
          );
          deps.log?.warn({ limit: config.smtp.dailyLimit }, 'limite diário de e-mails atingido');
        }
        continue;
      }
      const payload = payloadOf(row);
      try {
        await deps.mailer.send({
          to: user.email,
          subject: payload.subject ?? `${subjectPrefix(daycare.name)} ${row.title}`,
          text: row.body,
          html: payload.html,
          replyTo,
        });
        markSent(db, row, now);
        run(db, 'UPDATE users SET last_email_error = NULL WHERE id = ?', user.id);
        emailsToday++;
        summary.sent++;
      } catch (err) {
        const message = errorMessage(err);
        if (isTransientMailError(err)) {
          if (scheduleRetry(db, row, message, now)) summary.retried++;
          else {
            summary.failed++;
            run(db, 'UPDATE users SET last_email_error = ? WHERE id = ?', message.slice(0, 300), user.id);
          }
        } else {
          markFailed(db, row, message);
          run(db, 'UPDATE users SET last_email_error = ? WHERE id = ?', message.slice(0, 300), user.id);
          summary.failed++;
        }
        deps.log?.warn({ notificationId: row.id, err: message }, 'falha ao enviar e-mail');
      }
    } catch (err) {
      // Defensive: never let one row break the loop.
      markFailed(db, row, errorMessage(err));
      summary.failed++;
      deps.log?.error({ notificationId: row.id, err }, 'falha inesperada no despacho');
    }
  }
  return summary;
}

/** Runs dispatchOnce every 5 s (no overlap). Returns a stop function. */
export function startDispatcher(deps: DispatcherDeps, intervalMs = 5000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await dispatchOnce(deps);
      if (s.processed > 0) deps.log?.debug(s, 'despacho de notificações');
    } catch (err) {
      deps.log?.error({ err }, 'falha no despacho de notificações');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
