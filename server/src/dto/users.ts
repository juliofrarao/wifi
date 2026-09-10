/** users row → UserDTO / UserDetailDTO. */
import type { Preferences, UserDetailDTO, UserDTO } from '@creche/shared';
import { type Db, all, one } from '../db/index.js';
import { type UserRow, bool } from '../db/rows.js';
import { photoUrl } from '../lib/photos.js';
import { loadCredentials } from './credentials.js';

export interface DtoCtx {
  filesSecret: string;
}

export function userToDto(row: UserRow, ctx: DtoCtx): UserDTO {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    login: row.login,
    phone: row.phone,
    role: row.role,
    photoUrl: photoUrl(row.photo_file_id, ctx.filesSecret),
    active: bool(row.active),
    hasAccess: row.password_hash !== null,
    hasPin: row.pin_hash !== null,
    createdAt: row.created_at,
    anonymizedAt: row.anonymized_at,
  };
}

export function preferencesOf(row: UserRow): Preferences {
  return { notifyCheckinPush: bool(row.notify_checkin_push), notifyCheckinEmail: bool(row.notify_checkin_email) };
}

export function userDetail(db: Db, row: UserRow, ctx: DtoCtx): UserDetailDTO {
  const children = all<{
    id: string;
    name: string;
    class_name: string | null;
    photo_file_id: string | null;
    relationship: UserDetailDTO['children'][number]['relationship'];
    can_pickup: number;
    is_primary: number;
    blocked: number;
    valid_from: string | null;
    valid_until: string | null;
  }>(
    db,
    `SELECT c.id, c.name, c.class_name, c.photo_file_id, l.relationship, l.can_pickup, l.is_primary, l.blocked, l.valid_from, l.valid_until
     FROM child_guardians l JOIN children c ON c.id = l.child_id
     WHERE l.user_id = ? AND l.removed_at IS NULL ORDER BY c.name`,
    row.id
  );
  const pushSubscriptions = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', row.id)?.n ?? 0;
  const sessions = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', row.id)?.n ?? 0;
  return {
    ...userToDto(row, ctx),
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      className: c.class_name,
      photoUrl: photoUrl(c.photo_file_id, ctx.filesSecret),
      relationship: c.relationship,
      canPickup: bool(c.can_pickup),
      isPrimary: bool(c.is_primary),
      blocked: bool(c.blocked),
      validFrom: c.valid_from,
      validUntil: c.valid_until,
    })),
    credentials: row.role === 'guardian' ? loadCredentials(db, { ownerType: 'guardian', ownerId: row.id, includeRevoked: true }) : [],
    preferences: row.role === 'guardian' ? preferencesOf(row) : null,
    pushSubscriptions,
    lastEmailError: row.last_email_error,
    sessions,
  };
}
