/** /api/auth/* — login, logout, me, passwords, invites, resets, guard switch. */
import type { FastifyInstance } from 'fastify';
import {
  AcceptInviteBody,
  type AuthResult,
  ChangePasswordBody,
  ForgotPasswordBody,
  LoginBody,
  ResetPasswordBody,
  SwitchGuardBody,
} from '@creche/shared';
import type { Ctx } from '../context.js';
import { all, one, run, tx } from '../db/index.js';
import type { UserRow } from '../db/rows.js';
import { userToDto } from '../dto/users.js';
import { audit } from '../lib/audit.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { ApiError, rateLimited } from '../lib/errors.js';
import { photoUrl } from '../lib/photos.js';
import { LIMITS, assertNotLimited, clearFailures, identifierKey, ipKey, recordFailure } from '../lib/ratelimit.js';
import { parse } from '../lib/validate.js';
import { issueInvite, markTokenUsed, resolveAuthToken } from '../services/invites.js';
import { assertPasswordStrength, findUserByIdentifier } from '../services/users.js';
import { actorOf, authOf, requireAuth, requireRole } from './plugin.js';
import { createSession, revokeSession, revokeUserPushSubscriptions, revokeUserSessions, incrementSwitchFailures } from './sessions.js';

const MAX_SWITCH_FAILURES = 5;

export function registerAuthRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;

  const authResult = (user: UserRow, userAgent: string | null, now: Date): AuthResult => {
    const { token, session } = createSession(db, config, user.id, userAgent, now);
    return { token, user: userToDto(user, ctx), expiresAt: session.expires_at };
  };

  const ua = (h: unknown) => (typeof h === 'string' ? h : null);

  api.post('/auth/login', async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const now = req.now;
    const idKey = identifierKey(body.identifier);
    const ipK = ipKey(req.ip);
    assertNotLimited(db, idKey, LIMITS.loginIdentifier, now);
    assertNotLimited(db, ipK, LIMITS.loginIp, now);

    const user = findUserByIdentifier(db, body.identifier);
    const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyPassword(body.password, null);
    if (!user || !ok || !user.active) {
      recordFailure(db, idKey, now);
      recordFailure(db, ipK, now);
      throw new ApiError('INVALID_CREDENTIALS');
    }
    clearFailures(db, idKey);
    const result = authResult(user, ua(req.headers['user-agent']), now);
    audit(db, { id: user.id, name: user.name }, 'auth.login', 'user', user.id, { role: user.role }, req.ip, now);
    return reply.send(result);
  });

  api.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const { session } = authOf(req);
    revokeSession(db, session.id);
    return reply.code(204).send();
  });

  api.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    return { user: userToDto(authOf(req).user, ctx) };
  });

  api.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = parse(ChangePasswordBody, req.body);
    const { user, session } = authOf(req);
    const ok = await verifyPassword(body.currentPassword, user.password_hash);
    if (!ok) throw new ApiError('INVALID_CREDENTIALS', 'Senha atual incorreta');
    assertPasswordStrength(body.newPassword, user.role);
    const hash = await hashPassword(body.newPassword);
    const now = req.now;
    tx(db, () => {
      run(db, 'UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?', hash, now.toISOString(), now.toISOString(), user.id);
      revokeUserSessions(db, user.id, session.id);
      audit(db, actorOf(req), 'user.password_change', 'user', user.id, null, req.ip, now);
    });
    return reply.code(204).send();
  });

  api.get<{ Params: { token: string } }>('/auth/invite/:token', async (req) => {
    const { row, user } = resolveAuthToken(db, 'invite', req.params.token, req.now);
    return { name: user.name, role: user.role, expiresAt: row.expires_at };
  });

  api.post('/auth/accept-invite', async (req, reply) => {
    const body = parse(AcceptInviteBody, req.body);
    const now = req.now;
    const { row, user } = resolveAuthToken(db, 'invite', body.token, now);
    assertPasswordStrength(body.password, user.role);
    const hash = await hashPassword(body.password);
    const result = tx(db, () => {
      run(db, 'UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?', hash, now.toISOString(), now.toISOString(), user.id);
      markTokenUsed(db, row.id, now);
      const fresh = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id)!;
      audit(db, { id: user.id, name: user.name }, 'user.invite_accept', 'user', user.id, null, req.ip, now);
      return authResult(fresh, ua(req.headers['user-agent']), now);
    });
    return reply.send(result);
  });

  api.post('/auth/forgot-password', async (req, reply) => {
    const body = parse(ForgotPasswordBody, req.body);
    const user = findUserByIdentifier(db, body.identifier);
    if (user && user.active && user.email) {
      // Only users with an e-mail can self-reset; nothing is revealed either way.
      await issueInvite(ctx, user, { kind: 'reset', send: true });
      audit(db, null, 'auth.forgot_password', 'user', user.id, null, req.ip, req.now);
    }
    return reply.code(204).send();
  });

  api.get<{ Params: { token: string } }>('/auth/reset/:token', async (req) => {
    const { user } = resolveAuthToken(db, 'reset', req.params.token, req.now);
    return { name: user.name };
  });

  api.post('/auth/reset-password', async (req, reply) => {
    const body = parse(ResetPasswordBody, req.body);
    const now = req.now;
    const { row, user } = resolveAuthToken(db, 'reset', body.token, now);
    assertPasswordStrength(body.password, user.role);
    const hash = await hashPassword(body.password);
    const result = tx(db, () => {
      run(db, 'UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?', hash, now.toISOString(), now.toISOString(), user.id);
      markTokenUsed(db, row.id, now);
      revokeUserSessions(db, user.id);
      revokeUserPushSubscriptions(db, user.id);
      const fresh = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id)!;
      audit(db, { id: user.id, name: user.name }, 'user.password_reset', 'user', user.id, null, req.ip, now);
      return authResult(fresh, ua(req.headers['user-agent']), now);
    });
    return reply.send(result);
  });

  api.get('/auth/guards', { preHandler: requireRole('guard', 'admin') }, async () => {
    const rows = all<Pick<UserRow, 'id' | 'name' | 'photo_file_id'>>(
      db,
      `SELECT id, name, photo_file_id FROM users WHERE role = 'guard' AND active = 1 AND pin_hash IS NOT NULL AND anonymized_at IS NULL ORDER BY name`
    );
    return rows.map((r) => ({ id: r.id, name: r.name, photoUrl: photoUrl(r.photo_file_id, ctx.filesSecret) }));
  });

  api.post('/auth/switch', { preHandler: requireRole('guard', 'admin') }, async (req, reply) => {
    const body = parse(SwitchGuardBody, req.body);
    const { user: current, session } = authOf(req);
    const now = req.now;
    if (session.switch_failures >= MAX_SWITCH_FAILURES) throw rateLimited(15 * 60);
    const target = one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND role = 'guard' AND active = 1 AND anonymized_at IS NULL`, body.userId);
    if (!target || !target.pin_hash) throw new ApiError('NOT_FOUND', 'Vigilante não encontrado');
    const ok = await verifyPassword(body.pin, target.pin_hash);
    if (!ok) {
      const failures = incrementSwitchFailures(db, session.id);
      if (failures >= MAX_SWITCH_FAILURES) throw rateLimited(15 * 60);
      throw new ApiError('INVALID_PIN');
    }
    const result = tx(db, () => {
      const r = authResult(target, ua(req.headers['user-agent']), now);
      revokeSession(db, session.id);
      audit(db, { id: current.id, name: current.name }, 'auth.switch', 'user', target.id, { from: current.id }, req.ip, now);
      return r;
    });
    return reply.send(result);
  });

}
