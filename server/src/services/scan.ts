/**
 * Gate identification (spec §4.1): card lookup by code/uid, manual lookup by
 * name search, the offline directory (with an ETag) and the queue heartbeat.
 * Only failures count toward the per-session limit (R13).
 */
import {
  type ChildGateDTO,
  type GuardianLinkGate,
  type ScanChildDTO,
  type ScanDirectory,
  type ScanLookupResult,
  isValidCode,
  normalizeCode,
  normalizeUid,
  relationshipLabel,
  todayCivil,
} from '@creche/shared';
import type { Config } from '../config.js';
import { type Db, all, one, run } from '../db/index.js';
import { getDirectoryVersion } from '../db/settings.js';
import { type ChildRow, type CredentialRow, type LinkRow, type SessionRow, type UserRow, bool } from '../db/rows.js';
import { authorizationToDto, authorizationsByChild } from '../dto/authorizations.js';
import { childrenGate, linkAllowsPickupNow, linksByChild, linkToGate } from '../dto/children.js';
import { ApiError } from '../lib/errors.js';
import { photoUrl } from '../lib/photos.js';
import { LIMITS, assertNotLimited, lookupKey, recordFailure } from '../lib/ratelimit.js';
import { DAY_MS, normalizeIso } from '../lib/time.js';

export interface ScanCtx {
  db: Db;
  config: Config;
  filesSecret: string;
}

/** Revoked credentials stay in the directory for 90 days so the app can say "cancelada". */
export const REVOKED_IN_DIRECTORY_DAYS = 90;

type MatchedBy = 'code' | 'nfc_uid' | 'search';

function dtoCtx(ctx: ScanCtx, now: Date) {
  return { filesSecret: ctx.filesSecret, tz: ctx.config.tz, now };
}

/** Result for a guardian: the guardian and their linked, active children with link flags. */
export function guardianResult(ctx: ScanCtx, user: UserRow, matchedBy: MatchedBy, credentialId: string | null, now: Date): ScanLookupResult {
  const { db } = ctx;
  const today = todayCivil(ctx.config.tz, now);
  const links = all<LinkRow & { c_active: number }>(
    db,
    `SELECT l.*, c.active AS c_active FROM child_guardians l JOIN children c ON c.id = l.child_id
     WHERE l.user_id = ? AND l.removed_at IS NULL AND c.active = 1 AND c.anonymized_at IS NULL ORDER BY c.name`,
    user.id
  );
  const rows = links.map((l) => one<ChildRow>(db, 'SELECT * FROM children WHERE id = ?', l.child_id)!);
  const gate = childrenGate(db, rows, dtoCtx(ctx, now));
  const children: ScanChildDTO[] = gate.map((child, i) => {
    const l = links[i];
    return {
      ...child,
      relationship: l.relationship,
      relationshipLabel: relationshipLabel(l.relationship),
      canPickup: bool(l.can_pickup),
      blocked: bool(l.blocked),
      pickupAllowedNow: linkAllowsPickupNow(l, today),
    };
  });
  return {
    kind: 'guardian',
    matchedBy,
    credentialId,
    guardian: { id: user.id, name: user.name, photoUrl: photoUrl(user.photo_file_id, ctx.filesSecret) },
    children,
  };
}

/** Result for a child: the child, its (active) guardians and the authorizations valid today. */
export function childResult(ctx: ScanCtx, child: ChildRow, matchedBy: MatchedBy, credentialId: string | null, now: Date): ScanLookupResult {
  const { db } = ctx;
  const c = dtoCtx(ctx, now);
  const today = todayCivil(ctx.config.tz, now);
  const dto: ChildGateDTO = childrenGate(db, [child], c)[0];
  const guardians: GuardianLinkGate[] = (linksByChild(db, [child.id]).get(child.id) ?? []).filter((l) => bool(l.u_active)).map((l) => linkToGate(l, c, today));
  const authorizedPersons = (authorizationsByChild(db, [child.id], 'valid_today', today).get(child.id) ?? []).map((a) => authorizationToDto(a, { today, admin: false }));
  return { kind: 'child', matchedBy, credentialId, child: dto, guardians, authorizedPersons };
}

/** Owner of a credential, or OWNER_INACTIVE / NOT_FOUND. */
function ownerResult(ctx: ScanCtx, ownerType: 'guardian' | 'child', ownerId: string, matchedBy: MatchedBy, credentialId: string | null, now: Date): ScanLookupResult {
  const { db } = ctx;
  if (ownerType === 'guardian') {
    const user = one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND role = 'guardian'`, ownerId);
    if (!user) throw new ApiError('NOT_FOUND', 'Responsável não encontrado');
    if (!user.active || user.anonymized_at) throw new ApiError('OWNER_INACTIVE');
    return guardianResult(ctx, user, matchedBy, credentialId, now);
  }
  const child = one<ChildRow>(db, 'SELECT * FROM children WHERE id = ?', ownerId);
  if (!child) throw new ApiError('NOT_FOUND', 'Criança não encontrada');
  if (!child.active || child.anonymized_at) throw new ApiError('OWNER_INACTIVE');
  return childResult(ctx, child, matchedBy, credentialId, now);
}

/** Prefer the active credential holding a code/uid; otherwise the most recently revoked one. */
function credentialBy(db: Db, column: 'code' | 'nfc_uid', value: string): CredentialRow | undefined {
  return one<CredentialRow>(db, `SELECT * FROM credentials WHERE ${column} = ? ORDER BY active DESC, COALESCE(revoked_at, created_at) DESC LIMIT 1`, value);
}

export interface LookupInput {
  code?: string;
  uid?: string;
}

/**
 * POST /scan/lookup — code first, then uid. A revoked card answers
 * CARD_REVOKED with no fall-through; code and uid pointing at different
 * owners answer CREDENTIAL_MISMATCH. Misses count toward the session limit.
 */
export function lookupByCard(ctx: ScanCtx, session: SessionRow, input: LookupInput, now: Date): ScanLookupResult {
  const { db } = ctx;
  const key = lookupKey(session.id);
  assertNotLimited(db, key, LIMITS.lookupSession, now);
  const miss = (code: 'CARD_NOT_FOUND' | 'CREDENTIAL_MISMATCH'): never => {
    recordFailure(db, key, now);
    throw new ApiError(code);
  };
  const code = input.code ? normalizeCode(input.code) : null;
  const uid = input.uid ? normalizeUid(input.uid) : null;
  if (!code && !uid) miss('CARD_NOT_FOUND');

  const byCode = code && isValidCode(code) ? credentialBy(db, 'code', code) : undefined;
  const byUid = uid && uid.length >= 4 ? credentialBy(db, 'nfc_uid', uid) : undefined;

  if (byCode && byUid && byCode.id !== byUid.id && (byCode.owner_type !== byUid.owner_type || byCode.owner_id !== byUid.owner_id)) {
    miss('CREDENTIAL_MISMATCH');
  }
  const match = byCode ?? byUid;
  if (!match) return miss('CARD_NOT_FOUND');
  if (!match.active) throw new ApiError('CARD_REVOKED');
  return ownerResult(ctx, match.owner_type, match.owner_id, byCode ? 'code' : 'nfc_uid', match.id, now);
}

/** POST /scan/manual — resolution after a name search (method 'search'). Failures count too. */
export function lookupManual(ctx: ScanCtx, session: SessionRow, input: { ownerType: 'guardian' | 'child'; ownerId: string }, now: Date): ScanLookupResult {
  const { db } = ctx;
  const key = lookupKey(session.id);
  assertNotLimited(db, key, LIMITS.lookupSession, now);
  try {
    return ownerResult(ctx, input.ownerType, input.ownerId, 'search', null, now);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') recordFailure(db, key, now);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/**
 * ETag of the directory: changes with the directory version, the civil day
 * (validities and `stale` flags flip at midnight) and the last attendance
 * change (statuses). Anything else answers 304.
 */
export function directoryEtag(db: Db, config: Config, now: Date): string {
  const version = getDirectoryVersion(db);
  const today = todayCivil(config.tz, now);
  const stamp = one<{ s: string | null }>(db, 'SELECT MAX(MAX(created_at), COALESCE(MAX(voided_at), \'\')) AS s FROM attendance_events')?.s ?? '';
  return `"${version}-${today}-${stamp.replace(/[^0-9]/g, '') || '0'}"`;
}

export function buildDirectory(ctx: ScanCtx, now: Date): ScanDirectory {
  const { db } = ctx;
  const revokedSince = new Date(now.getTime() - REVOKED_IN_DIRECTORY_DAYS * DAY_MS).toISOString();
  const credentials = all<CredentialRow>(
    db,
    `SELECT cr.* FROM credentials cr
     WHERE (cr.active = 1 AND (
             (cr.owner_type = 'guardian' AND cr.owner_id IN (SELECT id FROM users WHERE role = 'guardian' AND active = 1 AND anonymized_at IS NULL))
          OR (cr.owner_type = 'child' AND cr.owner_id IN (SELECT id FROM children WHERE active = 1 AND anonymized_at IS NULL))))
        OR (cr.active = 0 AND cr.revoked_at >= ?)
     ORDER BY cr.created_at, cr.id`,
    revokedSince
  ).map((c) => ({
    id: c.id,
    ownerType: c.owner_type,
    ownerId: c.owner_id,
    code: c.code,
    nfcUid: c.nfc_uid,
    active: bool(c.active),
    revokedAt: c.revoked_at,
  }));
  const guardians = all<{ id: string; name: string; photo_file_id: string | null; active: number }>(
    db,
    `SELECT DISTINCT u.id, u.name, u.photo_file_id, u.active FROM users u
     JOIN child_guardians l ON l.user_id = u.id JOIN children c ON c.id = l.child_id
     WHERE u.role = 'guardian' AND u.active = 1 AND u.anonymized_at IS NULL AND l.removed_at IS NULL AND c.active = 1 AND c.anonymized_at IS NULL
     ORDER BY u.name, u.id`
  ).map((u) => ({ id: u.id, name: u.name, photoUrl: photoUrl(u.photo_file_id, ctx.filesSecret), active: bool(u.active) }));
  const rows = all<ChildRow>(db, 'SELECT * FROM children WHERE active = 1 AND anonymized_at IS NULL ORDER BY class_name, name');
  return {
    generatedAt: now.toISOString(),
    version: getDirectoryVersion(db),
    credentials,
    guardians,
    children: childrenGate(db, rows, dtoCtx(ctx, now)),
  };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function recordHeartbeat(db: Db, session: SessionRow, input: { queuedCount: number; oldestQueuedAt?: string | null; appVersion?: string | null }, now: Date): void {
  run(
    db,
    `INSERT INTO gate_heartbeats (session_id, user_id, queued_count, oldest_queued_at, app_version, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, queued_count = excluded.queued_count, oldest_queued_at = excluded.oldest_queued_at,
       app_version = excluded.app_version, at = excluded.at`,
    session.id,
    session.user_id,
    input.queuedCount,
    input.oldestQueuedAt ? normalizeIso(input.oldestQueuedAt) : null,
    input.appVersion ?? null,
    now.toISOString()
  );
}
