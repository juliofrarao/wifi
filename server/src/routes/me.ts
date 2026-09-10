/** /api/me/* — own profile, preferences, push subscriptions and children. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type Preferences, type PushPayload, PreferencesBody, PushSubscriptionBody, UnsubscribePushBody, UpdateMeBody } from '@creche/shared';
import { actorOf, authOf, requireAuth, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { all, one, run, tx } from '../db/index.js';
import { bumpDirectoryVersion, getSetting, SETTING_KEYS } from '../db/settings.js';
import type { ChildRow, LinkRow, PushSubscriptionRow, UserRow } from '../db/rows.js';
import { myChildren } from '../dto/children.js';
import { preferencesOf, userToDto } from '../dto/users.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

export function registerMeRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const dtoCtx = (now: Date) => ({ filesSecret: ctx.filesSecret, tz: ctx.config.tz, now });

  api.patch('/me', { preHandler: requireAuth }, async (req) => {
    const body = parse(UpdateMeBody, req.body);
    const { user } = authOf(req);
    const now = req.now;
    tx(db, () => {
      run(
        db,
        'UPDATE users SET name = COALESCE(?, name), phone = CASE WHEN ? THEN ? ELSE phone END, updated_at = ? WHERE id = ?',
        body.name ?? null,
        body.phone !== undefined ? 1 : 0,
        body.phone ?? null,
        now.toISOString(),
        user.id
      );
      if (body.name && body.name !== user.name) bumpDirectoryVersion(db);
      audit(db, actorOf(req), 'me.update', 'user', user.id, { name: body.name, phone: body.phone }, req.ip, now);
    });
    return userToDto(one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id)!, ctx);
  });

  api.get('/me/preferences', { preHandler: requireRole('guardian') }, async (req): Promise<Preferences> => {
    return preferencesOf(authOf(req).user);
  });

  api.patch('/me/preferences', { preHandler: requireRole('guardian') }, async (req): Promise<Preferences> => {
    const body = parse(PreferencesBody, req.body);
    const { user } = authOf(req);
    run(
      db,
      'UPDATE users SET notify_checkin_push = COALESCE(?, notify_checkin_push), notify_checkin_email = COALESCE(?, notify_checkin_email), updated_at = ? WHERE id = ?',
      body.notifyCheckinPush === undefined ? null : body.notifyCheckinPush ? 1 : 0,
      body.notifyCheckinEmail === undefined ? null : body.notifyCheckinEmail ? 1 : 0,
      req.now.toISOString(),
      user.id
    );
    return preferencesOf(one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id)!);
  });

  api.post('/me/push-subscriptions', { preHandler: requireRole('guardian', 'admin') }, async (req, reply) => {
    const body = parse(PushSubscriptionBody, req.body);
    const { user, session } = authOf(req);
    const now = req.now.toISOString();
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
    const id = tx(db, () => {
      const existing = one<PushSubscriptionRow>(db, 'SELECT * FROM push_subscriptions WHERE endpoint = ?', body.endpoint);
      if (existing) {
        run(
          db,
          'UPDATE push_subscriptions SET user_id = ?, session_id = ?, p256dh = ?, auth = ?, user_agent = ?, last_error = NULL WHERE id = ?',
          user.id,
          session.id,
          body.keys.p256dh,
          body.keys.auth,
          ua,
          existing.id
        );
        return existing.id;
      }
      const newId = randomUUID();
      run(
        db,
        `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        newId,
        user.id,
        session.id,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        ua,
        now
      );
      return newId;
    });
    return reply.code(201).send({ id });
  });

  api.post('/me/push-subscriptions/unsubscribe', { preHandler: requireRole('guardian', 'admin') }, async (req, reply) => {
    const body = parse(UnsubscribePushBody, req.body);
    const { user } = authOf(req);
    run(db, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', body.endpoint, user.id);
    return reply.code(204).send();
  });

  api.post('/me/push-subscriptions/test', { preHandler: requireRole('guardian', 'admin') }, async (req, reply) => {
    const { user, session } = authOf(req);
    const subs = all<PushSubscriptionRow>(
      db,
      'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END, created_at DESC',
      user.id,
      session.id
    );
    if (subs.length === 0) throw new ApiError('NOT_FOUND', 'Nenhuma inscrição de notificação neste aparelho');
    if (!ctx.push.enabled()) throw new ApiError('INVALID_STATE', 'Notificações push não configuradas neste servidor');
    const daycareName = getSetting(db, SETTING_KEYS.daycareName) ?? ctx.config.daycareName;
    const payload: PushPayload = {
      title: `${daycareName} — teste`,
      body: 'As notificações estão funcionando neste aparelho.',
      url: '/config',
      tag: 'test',
      notificationId: randomUUID(),
      kind: 'system',
      override: false,
    };
    const now = req.now.toISOString();
    for (const sub of subs) {
      const res = await ctx.push.send(sub, payload);
      if (res.gone) run(db, 'DELETE FROM push_subscriptions WHERE id = ?', sub.id);
      else if (res.ok) run(db, 'UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?', now, sub.id);
      else run(db, 'UPDATE push_subscriptions SET last_error = ? WHERE id = ?', res.error ?? 'erro', sub.id);
    }
    return reply.code(204).send();
  });

  api.get('/me/children', { preHandler: requireRole('guardian') }, async (req) => {
    const { user } = authOf(req);
    const links = all<LinkRow>(
      db,
      `SELECT l.* FROM child_guardians l JOIN children c ON c.id = l.child_id
       WHERE l.user_id = ? AND l.removed_at IS NULL AND l.blocked = 0 AND c.anonymized_at IS NULL ORDER BY c.name`,
      user.id
    );
    if (links.length === 0) return [];
    const byChild = new Map(links.map((l) => [l.child_id, l]));
    const children = links.map((l) => one<ChildRow>(db, 'SELECT * FROM children WHERE id = ?', l.child_id)!);
    return myChildren(db, children, byChild, dtoCtx(req.now));
  });
}
