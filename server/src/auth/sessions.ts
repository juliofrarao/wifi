/**
 * Opaque Bearer sessions. Token = 32 random bytes (base64url); only its
 * SHA-256 is stored. Sliding expiry (SESSION_TTL_DAYS) renewed when less than
 * half the TTL remains, capped at created_at + SESSION_MAX_DAYS.
 * Deleting a session cascades its push subscriptions (FK ON DELETE CASCADE).
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { type Db, one, run } from '../db/index.js';
import type { SessionRow } from '../db/rows.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { DAY_MS } from '../lib/time.js';

export interface CreatedSession {
  token: string;
  session: SessionRow;
}

/** min(now + TTL, created_at + MAX). */
export function sessionExpiry(config: Config, createdAt: Date, now: Date): Date {
  const sliding = now.getTime() + config.sessionTtlDays * DAY_MS;
  const absolute = createdAt.getTime() + config.sessionMaxDays * DAY_MS;
  return new Date(Math.min(sliding, absolute));
}

export function createSession(db: Db, config: Config, userId: string, userAgent: string | null, now: Date): CreatedSession {
  const token = randomToken(32);
  const id = randomUUID();
  const expiresAt = sessionExpiry(config, now, now);
  const session: SessionRow = {
    id,
    token_hash: sha256Hex(token),
    user_id: userId,
    user_agent: userAgent ? userAgent.slice(0, 300) : null,
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    switch_failures: 0,
  };
  run(
    db,
    `INSERT INTO sessions (id, token_hash, user_id, user_agent, created_at, last_seen_at, expires_at, switch_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    session.id,
    session.token_hash,
    session.user_id,
    session.user_agent,
    session.created_at,
    session.last_seen_at,
    session.expires_at
  );
  return { token, session };
}

/** Resolve a raw token to a live session (null when unknown, expired or past the absolute cap). */
export function findSession(db: Db, config: Config, token: string, now: Date): SessionRow | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = one<SessionRow>(db, 'SELECT * FROM sessions WHERE token_hash = ?', sha256Hex(token));
  if (!row) return null;
  const nowMs = now.getTime();
  if (new Date(row.expires_at).getTime() <= nowMs) {
    run(db, 'DELETE FROM sessions WHERE id = ?', row.id);
    return null;
  }
  if (new Date(row.created_at).getTime() + config.sessionMaxDays * DAY_MS <= nowMs) {
    run(db, 'DELETE FROM sessions WHERE id = ?', row.id);
    return null;
  }
  return row;
}

/** Update last_seen_at; renew expires_at when less than half the TTL remains. Mutates and returns the row. */
export function touchSession(db: Db, config: Config, session: SessionRow, now: Date): SessionRow {
  const remaining = new Date(session.expires_at).getTime() - now.getTime();
  const half = (config.sessionTtlDays * DAY_MS) / 2;
  const lastSeen = now.toISOString();
  if (remaining < half) {
    const renewed = sessionExpiry(config, new Date(session.created_at), now).toISOString();
    run(db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', lastSeen, renewed, session.id);
    session.expires_at = renewed;
  } else if (new Date(session.last_seen_at).getTime() + 60_000 < now.getTime()) {
    // Avoid a write on every request: bump last_seen_at at most once a minute.
    run(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', lastSeen, session.id);
  }
  session.last_seen_at = lastSeen;
  return session;
}

export function revokeSession(db: Db, sessionId: string): void {
  run(db, 'DELETE FROM sessions WHERE id = ?', sessionId);
}

/** Delete all sessions of a user (and, via FK, their push subscriptions), optionally keeping one. */
export function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): number {
  if (exceptSessionId) return run(db, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId).changes;
  return run(db, 'DELETE FROM sessions WHERE user_id = ?', userId).changes;
}

/** Remove push subscriptions of a user (sessions cascade theirs; this also catches orphans). */
export function revokeUserPushSubscriptions(db: Db, userId: string): number {
  return run(db, 'DELETE FROM push_subscriptions WHERE user_id = ?', userId).changes;
}

export function incrementSwitchFailures(db: Db, sessionId: string): number {
  run(db, 'UPDATE sessions SET switch_failures = switch_failures + 1 WHERE id = ?', sessionId);
  return one<{ n: number }>(db, 'SELECT switch_failures AS n FROM sessions WHERE id = ?', sessionId)?.n ?? 0;
}

/** Delete expired sessions (hourly job). */
export function pruneSessions(db: Db, config: Config, now: Date): number {
  const capBefore = new Date(now.getTime() - config.sessionMaxDays * DAY_MS).toISOString();
  return run(db, 'DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?', now.toISOString(), capBefore).changes;
}
