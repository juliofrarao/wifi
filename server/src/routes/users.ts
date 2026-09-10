/** /api/users/* — admin management of guardians, guards and admins. */
import type { FastifyInstance } from 'fastify';
import { type InviteResult, ROLES, AnonymizeBody, CreateUserBody, SetPinBody, UpdateUserBody, searchKey } from '@creche/shared';
import { actorOf, authOf, requireRole } from '../auth/plugin.js';
import { revokeUserPushSubscriptions, revokeUserSessions } from '../auth/sessions.js';
import type { Ctx } from '../context.js';
import { all, run, tx } from '../db/index.js';
import { bumpDirectoryVersion } from '../db/settings.js';
import type { UserRow } from '../db/rows.js';
import { userDetail, userToDto } from '../dto/users.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { photoUrl, storePhoto } from '../lib/photos.js';
import { parse, queryBool, queryStr } from '../lib/validate.js';
import { anonymizeUser, getUser } from '../services/anonymize.js';
import { issueInvite } from '../services/invites.js';
import { assertEmailFree, assertLoginFree, assertPasswordStrength, insertUser } from '../services/users.js';
import { readUploadedFile } from './upload.js';

const digitsOnly = (s: string) => s.replace(/[^0-9]/g, '');

export function registerUserRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const admin = requireRole('admin');

  const mustGet = (id: string): UserRow => {
    const u = getUser(db, id);
    if (!u) throw new ApiError('NOT_FOUND', 'Usuário não encontrado');
    return u;
  };

  api.get<{ Querystring: { role?: string; q?: string; includeInactive?: string } }>('/users', { preHandler: admin }, async (req) => {
    const role = queryStr(req.query.role);
    if (role && !(ROLES as readonly string[]).includes(role)) throw new ApiError('VALIDATION', 'Papel inválido');
    const includeInactive = queryBool(req.query.includeInactive);
    const q = queryStr(req.query.q);
    const rows = all<UserRow>(
      db,
      `SELECT * FROM users WHERE (? IS NULL OR role = ?) AND (? = 1 OR active = 1) ORDER BY name`,
      role ?? null,
      role ?? null,
      includeInactive ? 1 : 0
    );
    if (!q) return rows.map((u) => userToDto(u, ctx));
    const key = searchKey(q);
    const digits = digitsOnly(q);
    const filtered = rows.filter(
      (u) =>
        searchKey(u.name).includes(key) ||
        (u.email ?? '').toLowerCase().includes(key) ||
        (u.login ?? '').includes(key) ||
        (digits.length >= 4 && digitsOnly(u.phone ?? '').includes(digits))
    );
    return filtered.map((u) => userToDto(u, ctx));
  });

  api.post('/users', { preHandler: admin }, async (req, reply) => {
    const body = parse(CreateUserBody, req.body);
    const now = req.now;
    assertEmailFree(db, body.email);
    assertLoginFree(db, body.login);
    if (body.password) assertPasswordStrength(body.password, body.role);
    if (body.pin && body.role !== 'guard') throw new ApiError('VALIDATION', 'PIN só para vigilantes', { issues: [{ path: 'pin', message: 'PIN só para vigilantes' }] });
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    const pinHash = body.pin ? await hashPassword(body.pin) : null;
    const user = tx(db, () => {
      const u = insertUser(db, { name: body.name, email: body.email, login: body.login, phone: body.phone, role: body.role, passwordHash, pinHash, now });
      audit(db, actorOf(req), 'user.create', 'user', u.id, { role: u.role, email: u.email, login: u.login, withPassword: !!passwordHash }, req.ip, now);
      if (u.role === 'guardian') bumpDirectoryVersion(db);
      return u;
    });
    let invite: InviteResult | null = null;
    if (!passwordHash) {
      const send = body.sendInvite ?? !!user.email;
      invite = await issueInvite(ctx, user, { kind: 'invite', send });
    }
    return reply.code(201).send({ user: userToDto(user, ctx), invite });
  });

  api.get<{ Params: { id: string } }>('/users/:id', { preHandler: admin }, async (req) => {
    return userDetail(db, mustGet(req.params.id), ctx);
  });

  api.patch<{ Params: { id: string } }>('/users/:id', { preHandler: admin }, async (req) => {
    const body = parse(UpdateUserBody, req.body);
    const user = mustGet(req.params.id);
    const me = authOf(req).user;
    const now = req.now;
    if (user.anonymized_at) throw new ApiError('INVALID_STATE', 'Usuário anonimizado');
    if (body.password !== undefined) {
      if (user.role === 'guardian') {
        throw new ApiError('VALIDATION', 'Responsáveis definem a própria senha pelo convite ou link de redefinição', {
          issues: [{ path: 'password', message: 'Use o link de redefinição' }],
        });
      }
      assertPasswordStrength(body.password, user.role);
    }
    if (body.active === false && user.id === me.id) throw new ApiError('INVALID_STATE', 'Você não pode desativar a própria conta');
    if (body.email !== undefined) assertEmailFree(db, body.email, user.id);
    if (body.login !== undefined) assertLoginFree(db, body.login, user.id);
    const email = body.email === undefined ? user.email : body.email;
    const login = body.login === undefined ? user.login : body.login;
    if (user.role !== 'guardian' && !email && !login) {
      throw new ApiError('VALIDATION', 'Informe e-mail ou login', { issues: [{ path: 'email', message: 'Informe e-mail ou login' }] });
    }
    const passwordHash = body.password !== undefined ? await hashPassword(body.password) : null;

    tx(db, () => {
      run(
        db,
        `UPDATE users SET name = ?, email = ?, login = ?, phone = ?, active = ?, updated_at = ? WHERE id = ?`,
        body.name ?? user.name,
        email,
        login,
        body.phone === undefined ? user.phone : body.phone,
        body.active === undefined ? user.active : body.active ? 1 : 0,
        now.toISOString(),
        user.id
      );
      if (passwordHash) {
        run(db, 'UPDATE users SET password_hash = ?, password_set_at = ?, last_email_error = NULL WHERE id = ?', passwordHash, now.toISOString(), user.id);
        revokeUserSessions(db, user.id);
        revokeUserPushSubscriptions(db, user.id);
      }
      if (body.active === false) {
        revokeUserSessions(db, user.id);
        revokeUserPushSubscriptions(db, user.id);
        run(db, 'DELETE FROM gate_heartbeats WHERE user_id = ?', user.id);
      }
      const changed: Record<string, unknown> = {};
      for (const k of ['name', 'email', 'login', 'phone', 'active'] as const) if (body[k] !== undefined) changed[k] = body[k];
      if (passwordHash) changed.password = true;
      audit(db, actorOf(req), 'user.update', 'user', user.id, changed, req.ip, now);
      bumpDirectoryVersion(db);
    });
    return userToDto(mustGet(user.id), ctx);
  });

  api.post<{ Params: { id: string }; Body: { send?: boolean } | null }>('/users/:id/invite', { preHandler: admin }, async (req) => {
    const user = mustGet(req.params.id);
    if (!user.active || user.anonymized_at) throw new ApiError('INVALID_STATE', 'Usuário inativo');
    const send = typeof req.body === 'object' && req.body !== null && typeof req.body.send === 'boolean' ? req.body.send : true;
    const kind = user.password_hash ? 'reset' : 'invite';
    const result = await issueInvite(ctx, user, { kind, send });
    audit(db, actorOf(req), kind === 'invite' ? 'user.invite' : 'user.reset_link', 'user', user.id, { sent: result.sent }, req.ip, req.now);
    return result;
  });

  api.post<{ Params: { id: string } }>('/users/:id/photo', { preHandler: admin }, async (req) => {
    const user = mustGet(req.params.id);
    if (user.anonymized_at) throw new ApiError('INVALID_STATE', 'Usuário anonimizado');
    const buffer = await readUploadedFile(req, 'photo');
    const fileId = tx(db, () => {
      const id = storePhoto(db, config, { ownerTable: 'users', ownerId: user.id, buffer, actorId: authOf(req).user.id, now: req.now });
      audit(db, actorOf(req), 'user.photo', 'user', user.id, { fileId: id, size: buffer.length }, req.ip, req.now);
      bumpDirectoryVersion(db);
      return id;
    });
    return { photoUrl: photoUrl(fileId, ctx.filesSecret) };
  });

  api.post<{ Params: { id: string } }>('/users/:id/pin', { preHandler: admin }, async (req, reply) => {
    const body = parse(SetPinBody, req.body);
    const user = mustGet(req.params.id);
    if (user.role !== 'guard') throw new ApiError('VALIDATION', 'PIN só para vigilantes');
    const pinHash = await hashPassword(body.pin);
    run(db, 'UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', pinHash, req.now.toISOString(), user.id);
    audit(db, actorOf(req), 'user.pin', 'user', user.id, null, req.ip, req.now);
    return reply.code(204).send();
  });

  api.post<{ Params: { id: string } }>('/users/:id/sessions/revoke', { preHandler: admin }, async (req, reply) => {
    const user = mustGet(req.params.id);
    tx(db, () => {
      const n = revokeUserSessions(db, user.id);
      revokeUserPushSubscriptions(db, user.id);
      run(db, 'DELETE FROM gate_heartbeats WHERE user_id = ?', user.id);
      audit(db, actorOf(req), 'user.sessions_revoke', 'user', user.id, { sessions: n }, req.ip, req.now);
    });
    return reply.code(204).send();
  });

  api.post<{ Params: { id: string } }>('/users/:id/anonymize', { preHandler: admin }, async (req, reply) => {
    const body = parse(AnonymizeBody, req.body);
    const user = mustGet(req.params.id);
    anonymizeUser(db, config, user, { actor: actorOf(req), reason: body.reason, ip: req.ip, now: req.now });
    return reply.code(204).send();
  });
}
