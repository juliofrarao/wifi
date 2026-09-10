/** /api/admin/* — dashboard stats, settings, audit, notifications, gate status, backup, import. */
import type { FastifyInstance } from 'fastify';
import {
  type AdminNotificationRow,
  type AdminStats,
  type AuditPage,
  type DaycareSettings,
  type GateStatus,
  NOTIFICATION_STATUSES,
  DaycareSettingsBody,
  todayCivil,
} from '@creche/shared';
import { actorOf, authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { type Db, all, one, placeholders, tx } from '../db/index.js';
import { getSetting, getSettingBool, SETTING_KEYS, setSetting } from '../db/settings.js';
import type { AuditRow, ChildRow, EventRow, GateHeartbeatRow } from '../db/rows.js';
import { childrenGate } from '../dto/children.js';
import { eventToDto } from '../dto/events.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { DAY_MS, civilDayRange } from '../lib/time.js';
import { parse, queryBool, queryInt, queryStr } from '../lib/validate.js';
import { absentStreaks } from '../services/absence.js';
import { createBackupArchive, lastBackupAt, runBackup } from '../services/backup.js';
import { testEmail } from '../services/email.js';
import { applyImport, importTemplateCsv, planImport } from '../services/import.js';
import { presentChildren } from '../services/status.js';
import { readUploadedFile } from './upload.js';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function daycareSettingsOf(db: Db, fallbackName: string): DaycareSettings {
  return {
    daycareName: getSetting(db, SETTING_KEYS.daycareName) ?? fallbackName,
    daycarePhone: getSetting(db, SETTING_KEYS.daycarePhone),
    contactEmail: getSetting(db, SETTING_KEYS.contactEmail),
  };
}

export function gateStatuses(db: Db, now: Date): GateStatus[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = all<GateHeartbeatRow & { guard_name: string }>(
    db,
    `SELECT h.*, u.name AS guard_name FROM gate_heartbeats h JOIN users u ON u.id = h.user_id WHERE h.at >= ? ORDER BY h.at DESC`,
    since
  );
  return rows.map((h) => ({
    sessionId: h.session_id,
    guardId: h.user_id,
    guardName: h.guard_name,
    queuedCount: h.queued_count,
    oldestQueuedAt: h.oldest_queued_at,
    appVersion: h.app_version,
    at: h.at,
  }));
}

export function registerAdminRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const admin = requireRole('admin');
  const dtoCtx = (now: Date) => ({ filesSecret: ctx.filesSecret, tz: config.tz, now });

  api.get('/admin/stats', { preHandler: admin }, async (req): Promise<AdminStats> => {
    const now = req.now;
    const tz = config.tz;
    const today = todayCivil(tz, now);
    const [dayStart, dayEnd] = civilDayRange(today, tz);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();

    const { present, stale } = presentChildren(db, { now, tz, admin: true });
    const count = (sql: string, ...params: unknown[]) => one<{ n: number }>(db, sql, ...params)?.n ?? 0;

    const checkinsToday = count(`SELECT COUNT(*) AS n FROM attendance_events WHERE type = 'checkin' AND voided_at IS NULL AND occurred_at >= ? AND occurred_at < ?`, dayStart, dayEnd);
    const checkoutsToday = count(`SELECT COUNT(*) AS n FROM attendance_events WHERE type = 'checkout' AND voided_at IS NULL AND occurred_at >= ? AND occurred_at < ?`, dayStart, dayEnd);
    const childrenActive = count('SELECT COUNT(*) AS n FROM children WHERE active = 1');
    const guardiansActive = count(`SELECT COUNT(*) AS n FROM users WHERE role = 'guardian' AND active = 1 AND anonymized_at IS NULL`);
    const guardiansWithoutAccess = count(`SELECT COUNT(*) AS n FROM users WHERE role = 'guardian' AND active = 1 AND anonymized_at IS NULL AND password_hash IS NULL`);
    const childrenWithoutReachableGuardian = count(
      `SELECT COUNT(*) AS n FROM children c WHERE c.active = 1 AND NOT EXISTS (
         SELECT 1 FROM child_guardians l JOIN users u ON u.id = l.user_id
         WHERE l.child_id = c.id AND l.removed_at IS NULL AND l.blocked = 0 AND u.active = 1 AND u.anonymized_at IS NULL
           AND (u.email IS NOT NULL OR u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)))`
    );
    const childrenWithoutConsent = count('SELECT COUNT(*) AS n FROM children WHERE active = 1 AND consent_at IS NULL');

    const activeChildren = all<ChildRow>(db, 'SELECT * FROM children WHERE active = 1 ORDER BY name');
    const { streaks } = absentStreaks(db, activeChildren.map((c) => c.id), { now, tz });
    const childrenAbsent5Days = activeChildren
      .map((c) => ({ id: c.id, name: c.name, className: c.class_name, absentStreakDays: streaks.get(c.id) ?? 0 }))
      .filter((c) => c.absentStreakDays >= 5)
      .sort((a, b) => b.absentStreakDays - a.absentStreakDays || a.name.localeCompare(b.name));

    const staleRows = stale.length ? all<ChildRow>(db, `SELECT * FROM children WHERE id IN (${placeholders(stale.length)}) ORDER BY name`, ...stale) : [];
    const staleChildren = childrenGate(db, staleRows, dtoCtx(now));

    const recent = (where: string) =>
      all<EventRow>(db, `SELECT * FROM attendance_events WHERE ${where} AND voided_at IS NULL AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 50`, weekAgo).map((e) =>
        eventToDto(e, { admin: true })
      );

    const notifications: AdminStats['notifications'] = {
      failedLast24h: count(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND created_at >= ?`, dayAgo),
      skippedLast24h: count(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'skipped' AND created_at >= ?`, dayAgo),
      emailsToday: count(`SELECT COUNT(*) AS n FROM notifications WHERE channel = 'email' AND status = 'sent' AND sent_at >= ? AND sent_at < ?`, dayStart, dayEnd),
      emailDailyLimit: config.smtp.dailyLimit,
      emailEnabled: ctx.mailer.enabled,
      pushEnabled: ctx.push.enabled(),
    };

    return {
      presentNow: present.length,
      stalePresentCount: stale.length,
      checkinsToday,
      checkoutsToday,
      childrenActive,
      guardiansActive,
      guardiansWithoutAccess,
      childrenWithoutReachableGuardian,
      childrenWithoutConsent,
      childrenAbsent5Days,
      staleChildren,
      recentOverrides: recent('override = 1'),
      recentConflicts: recent('conflict IS NOT NULL'),
      recentDenied: recent(`type = 'denied'`),
      notifications,
      gate: gateStatuses(db, now),
      lastBackupAt: lastBackupAt(db),
      demoData: getSettingBool(db, SETTING_KEYS.demoData, false),
    };
  });

  api.get('/admin/settings', { preHandler: admin }, async (): Promise<DaycareSettings> => daycareSettingsOf(db, config.daycareName));

  api.patch('/admin/settings', { preHandler: admin }, async (req): Promise<DaycareSettings> => {
    const body = parse(DaycareSettingsBody, req.body);
    tx(db, () => {
      if (body.daycareName !== undefined) setSetting(db, SETTING_KEYS.daycareName, body.daycareName);
      if (body.daycarePhone !== undefined) setSetting(db, SETTING_KEYS.daycarePhone, body.daycarePhone || null);
      if (body.contactEmail !== undefined) setSetting(db, SETTING_KEYS.contactEmail, body.contactEmail || null);
      audit(db, actorOf(req), 'settings.update', 'settings', null, body, req.ip, req.now);
    });
    return daycareSettingsOf(db, config.daycareName);
  });

  api.post('/admin/test-email', { preHandler: admin }, async (req, reply) => {
    if (!ctx.mailer.enabled) throw new ApiError('EMAIL_DISABLED');
    const { user } = authOf(req);
    const to = user.email ?? getSetting(db, SETTING_KEYS.contactEmail);
    if (!to) throw new ApiError('VALIDATION', 'Sua conta não tem e-mail e não há e-mail de contato configurado');
    const daycareName = getSetting(db, SETTING_KEYS.daycareName) ?? config.daycareName;
    try {
      await ctx.mailer.send({ to, replyTo: getSetting(db, SETTING_KEYS.contactEmail), ...testEmail(daycareName, req.now, config.tz) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError('EMAIL_DISABLED', `Falha ao enviar: ${message}`);
    }
    audit(db, actorOf(req), 'settings.test_email', 'settings', null, { to }, req.ip, req.now);
    return reply.code(204).send();
  });

  api.get<{ Querystring: { limit?: string; before?: string } }>('/admin/audit', { preHandler: admin }, async (req): Promise<AuditPage> => {
    const limit = queryInt(req.query.limit, 100, 1, 500);
    const before = queryStr(req.query.before);
    const rows = before
      ? all<AuditRow>(db, 'SELECT * FROM audit_log WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?', before, limit)
      : all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?', limit);
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actorId: r.actor_id,
        actorName: r.actor_name,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        details: r.details_json ? JSON.parse(r.details_json) : null,
        ip: r.ip,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1].at : null,
    };
  });

  api.get<{ Querystring: { status?: string; limit?: string } }>('/admin/notifications', { preHandler: admin }, async (req): Promise<AdminNotificationRow[]> => {
    const status = queryStr(req.query.status);
    if (status && !(NOTIFICATION_STATUSES as readonly string[]).includes(status)) throw new ApiError('VALIDATION', 'status inválido');
    const limit = queryInt(req.query.limit, 100, 1, 500);
    const rows = all<{
      id: string;
      user_id: string;
      user_name: string;
      kind: AdminNotificationRow['kind'];
      channel: AdminNotificationRow['channel'];
      status: AdminNotificationRow['status'];
      error: string | null;
      attempts: number;
      created_at: string;
      sent_at: string | null;
    }>(
      db,
      `SELECT n.id, n.user_id, u.name AS user_name, n.kind, n.channel, n.status, n.error, n.attempts, n.created_at, n.sent_at
       FROM notifications n JOIN users u ON u.id = n.user_id
       WHERE (? IS NULL OR n.status = ?) ORDER BY n.created_at DESC LIMIT ?`,
      status ?? null,
      status ?? null,
      limit
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      kind: r.kind,
      channel: r.channel,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      createdAt: r.created_at,
      sentAt: r.sent_at,
    }));
  });

  api.get('/admin/gate-status', { preHandler: admin }, async (req): Promise<GateStatus[]> => gateStatuses(db, req.now));

  api.post('/admin/backup', { preHandler: admin }, async (req) => {
    const res = await runBackup(db, config, req.now);
    audit(db, actorOf(req), 'backup.run', 'backup', null, { path: res.path, removed: res.removed }, req.ip, req.now);
    return { lastBackupAt: res.lastBackupAt };
  });

  api.get('/admin/backup', { preHandler: admin }, async (req, reply) => {
    const archive = await createBackupArchive(db, config, req.now);
    audit(db, actorOf(req), 'backup.download', 'backup', null, { filename: archive.filename }, req.ip, req.now);
    reply.header('Content-Disposition', `attachment; filename="${archive.filename}"`);
    reply.header('Cache-Control', 'no-store');
    reply.type('application/gzip');
    return reply.send(archive.stream);
  });

  api.post<{ Querystring: { dryRun?: string } }>('/admin/import', { preHandler: admin }, async (req) => {
    const dryRun = queryBool(req.query.dryRun, false);
    const buffer = await readUploadedFile(req, 'file', MAX_IMPORT_BYTES);
    const plan = planImport(db, buffer, dryRun);
    if (dryRun) {
      const { ops: _ops, ...result } = plan;
      return result;
    }
    return applyImport(db, plan, actorOf(req), req.ip, req.now);
  });

  api.get('/admin/import/template.csv', { preHandler: admin }, async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="modelo-importacao.csv"');
    reply.type('text/csv; charset=utf-8');
    return reply.send(importTemplateCsv());
  });
}
