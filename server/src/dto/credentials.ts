/** credentials row (+ owner name/class) → CredentialDTO. */
import type { CredentialDTO, OwnerType } from '@creche/shared';
import { type Db, all, one } from '../db/index.js';
import { type CredentialWithOwnerRow, bool } from '../db/rows.js';

export function credentialToDto(row: CredentialWithOwnerRow): CredentialDTO {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerClassName: row.owner_class_name,
    code: row.code,
    nfcUid: row.nfc_uid,
    label: row.label,
    active: bool(row.active),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export const CREDENTIAL_SELECT = `
  SELECT cr.*,
    CASE cr.owner_type WHEN 'guardian' THEN (SELECT u.name FROM users u WHERE u.id = cr.owner_id)
                       ELSE (SELECT c.name FROM children c WHERE c.id = cr.owner_id) END AS owner_name,
    CASE cr.owner_type WHEN 'child' THEN (SELECT c.class_name FROM children c WHERE c.id = cr.owner_id) ELSE NULL END AS owner_class_name
  FROM credentials cr`;

export interface CredentialFilter {
  ownerType?: OwnerType;
  ownerId?: string;
  /** Children of this class, or guardians linked (live link) to children of this class. */
  className?: string;
  includeRevoked?: boolean;
}

export function loadCredentialRows(db: Db, filter: CredentialFilter): CredentialWithOwnerRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.ownerType) {
    where.push('cr.owner_type = ?');
    params.push(filter.ownerType);
  }
  if (filter.ownerId) {
    where.push('cr.owner_id = ?');
    params.push(filter.ownerId);
  }
  if (!filter.includeRevoked) where.push('cr.active = 1');
  if (filter.className) {
    where.push(
      `((cr.owner_type = 'child' AND cr.owner_id IN (SELECT id FROM children WHERE class_name = ?))
        OR (cr.owner_type = 'guardian' AND cr.owner_id IN (
          SELECT l.user_id FROM child_guardians l JOIN children c ON c.id = l.child_id
          WHERE l.removed_at IS NULL AND c.class_name = ?)))`
    );
    params.push(filter.className, filter.className);
  }
  const sql = `${CREDENTIAL_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY cr.created_at DESC, cr.id`;
  return all<CredentialWithOwnerRow>(db, sql, ...params);
}

export function loadCredentials(db: Db, filter: CredentialFilter): CredentialDTO[] {
  return loadCredentialRows(db, filter).map(credentialToDto);
}

export function loadCredentialRow(db: Db, id: string): CredentialWithOwnerRow | undefined {
  return one<CredentialWithOwnerRow>(db, `${CREDENTIAL_SELECT} WHERE cr.id = ?`, id);
}

/** Active credentials grouped by owner id (for list projections). */
export function credentialsByOwner(db: Db, ownerType: OwnerType, ownerIds: string[]): Map<string, CredentialDTO[]> {
  const out = new Map<string, CredentialDTO[]>();
  if (ownerIds.length === 0) return out;
  const rows = loadCredentialRows(db, { ownerType, includeRevoked: false });
  const wanted = new Set(ownerIds);
  for (const row of rows) {
    if (!wanted.has(row.owner_id)) continue;
    const list = out.get(row.owner_id) ?? [];
    list.push(credentialToDto(row));
    out.set(row.owner_id, list);
  }
  return out;
}
