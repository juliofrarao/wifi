/** pickup_authorizations row → PickupAuthorizationDTO. personDocument only for admin. */
import { type PickupAuthorizationDTO, addDays, authorizationValid, relationshipLabel } from '@creche/shared';
import { type Db, all, one, placeholders } from '../db/index.js';
import type { AuthorizationWithCreatorRow } from '../db/rows.js';

export interface AuthorizationDtoCtx {
  today: string;
  admin: boolean;
}

export function authorizationToDto(row: AuthorizationWithCreatorRow, ctx: AuthorizationDtoCtx): PickupAuthorizationDTO {
  return {
    id: row.id,
    childId: row.child_id,
    personName: row.person_name,
    personDocument: ctx.admin ? row.person_document : null,
    relationshipLabel: row.relationship_label,
    phone: row.phone,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    note: row.note,
    createdBy: { id: row.created_by, name: row.c_name, relationshipLabel: row.c_relationship ? relationshipLabel(row.c_relationship) : null },
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    validNow: authorizationValid({ validFrom: row.valid_from, validUntil: row.valid_until, revokedAt: row.revoked_at }, ctx.today),
  };
}

/** Joins the creator's name and their (live) relationship to the child. */
export const AUTHORIZATION_SELECT = `
  SELECT a.*, u.name AS c_name,
    (SELECT l.relationship FROM child_guardians l WHERE l.child_id = a.child_id AND l.user_id = a.created_by AND l.removed_at IS NULL LIMIT 1) AS c_relationship
  FROM pickup_authorizations a JOIN users u ON u.id = a.created_by`;

export const AUTHORIZATION_ORDER = 'a.valid_from DESC, a.created_at DESC, a.id';

export function loadAuthorization(db: Db, id: string): AuthorizationWithCreatorRow | undefined {
  return one<AuthorizationWithCreatorRow>(db, `${AUTHORIZATION_SELECT} WHERE a.id = ?`, id);
}

export type AuthorizationScope = 'valid_today' | 'current' | 'all';

/**
 * Authorizations of many children.
 *  - valid_today: not revoked, valid_from <= today <= valid_until (gate / guardian view);
 *  - current: not revoked and valid_until >= today - 30 days (admin `authorizations`);
 *  - all: everything, including revoked.
 */
export function authorizationsByChild(db: Db, childIds: string[], scope: AuthorizationScope, today: string): Map<string, AuthorizationWithCreatorRow[]> {
  const out = new Map<string, AuthorizationWithCreatorRow[]>();
  if (childIds.length === 0) return out;
  let where = `a.child_id IN (${placeholders(childIds.length)})`;
  const params: unknown[] = [...childIds];
  if (scope === 'valid_today') {
    where += ' AND a.revoked_at IS NULL AND a.valid_from <= ? AND a.valid_until >= ?';
    params.push(today, today);
  } else if (scope === 'current') {
    where += ' AND a.revoked_at IS NULL AND a.valid_until >= ?';
    params.push(addDays(today, -30));
  }
  const rows = all<AuthorizationWithCreatorRow>(db, `${AUTHORIZATION_SELECT} WHERE ${where} ORDER BY ${AUTHORIZATION_ORDER}`, ...params);
  for (const row of rows) {
    const list = out.get(row.child_id) ?? [];
    list.push(row);
    out.set(row.child_id, list);
  }
  return out;
}
