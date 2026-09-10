/**
 * Request authentication. The onRequest hook resolves the Bearer token to
 * `request.auth = { user, session }` (null when absent or invalid — protected
 * routes then fail with UNAUTHORIZED through `requireRole`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@creche/shared';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import type { SessionRow, UserRow } from '../db/rows.js';
import { ApiError } from '../lib/errors.js';
import { findSession, touchSession } from './sessions.js';

export interface AuthInfo {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
    /** Instant the request started (from ctx.now) — routes use it as "now". */
    now: Date;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('now', null as unknown as Date);
  app.addHook('onRequest', async (req) => {
    req.now = ctx.now();
    req.auth = null;
    const token = bearerToken(req);
    if (!token) return;
    const session = findSession(ctx.db, ctx.config, token, req.now);
    if (!session) return;
    const user = one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ? AND active = 1', session.user_id);
    if (!user) return;
    touchSession(ctx.db, ctx.config, session, req.now);
    req.auth = { user, session };
  });
}

/** preHandler: requires a valid session (any role). */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw new ApiError('UNAUTHORIZED');
}

/** preHandler factory: requires a valid session with one of the roles. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.auth) throw new ApiError('UNAUTHORIZED');
    if (!roles.includes(req.auth.user.role)) throw new ApiError('FORBIDDEN');
  };
}

/** Narrowed accessor for handlers guarded by requireAuth/requireRole. */
export function authOf(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw new ApiError('UNAUTHORIZED');
  return req.auth;
}

export function actorOf(req: FastifyRequest): { id: string; name: string } {
  const a = authOf(req);
  return { id: a.user.id, name: a.user.name };
}
