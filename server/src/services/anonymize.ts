/**
 * Anonymization (spec §11): keeps rows and event snapshots, replaces names,
 * drops contacts/photos/notes, revokes credentials and sessions. Shared by
 * the admin routes and by `npm run purge`.
 */
import type { Config } from '../config.js';
import { type Db, one, run, tx } from '../db/index.js';
import { bumpDirectoryVersion } from '../db/settings.js';
import type { ChildRow, UserRow } from '../db/rows.js';
import { type Actor, audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { removePhoto } from '../lib/photos.js';

export function suffixOf(id: string): string {
  return id.replace(/-/g, '').slice(-4).toUpperCase();
}

export interface AnonymizeOptions {
  actor: Actor | null;
  reason: string;
  ip?: string | null;
  now: Date;
}

function revokeCredentials(db: Db, ownerType: 'guardian' | 'child', ownerId: string, actorId: string | null, nowIso: string): number {
  return run(
    db,
    'UPDATE credentials SET active = 0, revoked_at = ?, revoked_by = ? WHERE owner_type = ? AND owner_id = ? AND active = 1',
    nowIso,
    actorId,
    ownerType,
    ownerId
  ).changes;
}

/** Anonymize an INACTIVE child. Throws INVALID_STATE when still active. */
export function anonymizeChild(db: Db, config: Config, child: ChildRow, opts: AnonymizeOptions): void {
  if (child.active) throw new ApiError('INVALID_STATE', 'Desative a criança antes de anonimizar');
  if (child.anonymized_at) return;
  const nowIso = opts.now.toISOString();
  tx(db, () => {
    removePhoto(db, config, 'children', child.id, opts.now);
    run(
      db,
      `UPDATE children SET name = ?, birth_date = NULL, gate_alert = NULL, notes = NULL,
         consent_at = NULL, consent_by_name = NULL, consent_relationship = NULL,
         anonymized_at = ?, updated_at = ? WHERE id = ?`,
      `Criança removida #${suffixOf(child.id)}`,
      nowIso,
      nowIso,
      child.id
    );
    revokeCredentials(db, 'child', child.id, opts.actor?.id ?? null, nowIso);
    run(db, 'UPDATE pickup_authorizations SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?), person_document = NULL WHERE child_id = ?', nowIso, opts.actor?.id ?? null, child.id);
    run(db, 'UPDATE child_guardians SET removed_at = ?, removed_by = ? WHERE child_id = ? AND removed_at IS NULL', nowIso, opts.actor?.id ?? null, child.id);
    bumpDirectoryVersion(db);
    audit(db, opts.actor, 'child.anonymize', 'child', child.id, { reason: opts.reason }, opts.ip, opts.now);
  });
}

/** Anonymize an INACTIVE user. Throws INVALID_STATE when still active. */
export function anonymizeUser(db: Db, config: Config, user: UserRow, opts: AnonymizeOptions): void {
  if (user.active) throw new ApiError('INVALID_STATE', 'Desative o usuário antes de anonimizar');
  if (user.anonymized_at) return;
  const nowIso = opts.now.toISOString();
  const suffix = suffixOf(user.id);
  tx(db, () => {
    removePhoto(db, config, 'users', user.id, opts.now);
    if (user.role === 'guardian') {
      run(
        db,
        `UPDATE users SET name = ?, email = NULL, login = NULL, phone = NULL, password_hash = NULL, pin_hash = NULL,
           last_email_error = NULL, anonymized_at = ?, updated_at = ? WHERE id = ?`,
        `Responsável removido #${suffix}`,
        nowIso,
        nowIso,
        user.id
      );
    } else {
      // admin/guard rows must keep an e-mail or a login (schema CHECK): keep a synthetic login.
      run(
        db,
        `UPDATE users SET name = ?, email = NULL, login = ?, phone = NULL, password_hash = NULL, pin_hash = NULL,
           last_email_error = NULL, anonymized_at = ?, updated_at = ? WHERE id = ?`,
        `Usuário removido #${suffix}`,
        `removido-${user.id.replace(/-/g, '').slice(-12).toLowerCase()}`,
        nowIso,
        nowIso,
        user.id
      );
    }
    revokeCredentials(db, 'guardian', user.id, opts.actor?.id ?? null, nowIso);
    run(db, 'DELETE FROM sessions WHERE user_id = ?', user.id);
    run(db, 'DELETE FROM push_subscriptions WHERE user_id = ?', user.id);
    run(db, 'DELETE FROM auth_tokens WHERE user_id = ?', user.id);
    run(db, 'DELETE FROM gate_heartbeats WHERE user_id = ?', user.id);
    run(db, 'UPDATE child_guardians SET removed_at = ?, removed_by = ? WHERE user_id = ? AND removed_at IS NULL', nowIso, opts.actor?.id ?? null, user.id);
    bumpDirectoryVersion(db);
    audit(db, opts.actor, 'user.anonymize', 'user', user.id, { reason: opts.reason, role: user.role }, opts.ip, opts.now);
  });
}

export function getUser(db: Db, id: string): UserRow | undefined {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
}
