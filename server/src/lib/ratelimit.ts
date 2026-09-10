/**
 * Failure-based rate limits backed by the login_attempts table (R13).
 * Only failures are recorded; valid sessions are never throttled.
 *
 * Keys: `id:<identifier>` | `ip:<ip>` | `lookup:<sessionId>` | `pin:<userId>` | `forgot:<identifier>`.
 */
import type { Db } from '../db/index.js';
import { rateLimited } from './errors.js';
import { DAY_MS, MINUTE_MS } from './time.js';

export interface Limit {
  max: number;
  windowMs: number;
}

export const LIMITS = {
  loginIdentifier: { max: 5, windowMs: 15 * MINUTE_MS } satisfies Limit,
  loginIp: { max: 20, windowMs: 15 * MINUTE_MS } satisfies Limit,
  lookupSession: { max: 20, windowMs: 10 * MINUTE_MS } satisfies Limit,
  /** Wrong PINs against one guard, whatever session or device tries (SEC-1). */
  pinTarget: { max: 5, windowMs: 15 * MINUTE_MS } satisfies Limit,
  /** Password-reset requests per identifier; every call counts (SEC-2). */
  forgotIdentifier: { max: 3, windowMs: 15 * MINUTE_MS } satisfies Limit,
} as const;

export function identifierKey(identifier: string): string {
  return `id:${identifier.trim().toLowerCase()}`;
}
export function ipKey(ip: string): string {
  return `ip:${ip}`;
}
export function lookupKey(sessionId: string): string {
  return `lookup:${sessionId}`;
}
export function pinKey(userId: string): string {
  return `pin:${userId}`;
}
export function forgotKey(identifier: string): string {
  return `forgot:${identifier.trim().toLowerCase()}`;
}

export interface LimitCheck {
  limited: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** Count failures for `key` inside the window; when at/over the limit, say how long to wait. */
export function checkLimit(db: Db, key: string, limit: Limit, now: Date = new Date()): LimitCheck {
  const since = new Date(now.getTime() - limit.windowMs).toISOString();
  const row = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE key = ? AND at > ?').get(key, since) as {
    n: number;
    oldest: string | null;
  };
  if (row.n < limit.max || !row.oldest) return { limited: false, count: row.n, retryAfterSeconds: 0 };
  const retryAt = new Date(row.oldest).getTime() + limit.windowMs;
  return { limited: true, count: row.n, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)) };
}

/** Throws RATE_LIMITED (429 + retryAfterSeconds) when the key is over its limit. */
export function assertNotLimited(db: Db, key: string, limit: Limit, now: Date = new Date()): void {
  const check = checkLimit(db, key, limit, now);
  if (check.limited) throw rateLimited(check.retryAfterSeconds);
}

export function recordFailure(db: Db, key: string, now: Date = new Date()): void {
  db.prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').run(key, now.toISOString());
}

export function clearFailures(db: Db, key: string): void {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/** Delete attempts older than 24 h (called by the hourly job and by `npm run purge`). */
export function pruneAttempts(db: Db, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  return db.prepare('DELETE FROM login_attempts WHERE at < ?').run(cutoff).changes;
}
