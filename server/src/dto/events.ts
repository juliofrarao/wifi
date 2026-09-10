/** attendance_events row → AttendanceEventDTO (personDocument only for admin). */
import type { AttendanceEventDTO } from '@creche/shared';
import { type Db, all, placeholders } from '../db/index.js';
import { type EventRow, bool } from '../db/rows.js';

export interface EventDtoOptions {
  /** Admin sees person_document; everyone else gets null. */
  admin: boolean;
}

export function eventToDto(row: EventRow, opts: EventDtoOptions): AttendanceEventDTO {
  return {
    id: row.id,
    batchId: row.batch_id,
    clientId: row.client_id,
    childId: row.child_id,
    childName: row.child_name,
    type: row.type,
    guardianId: row.guardian_id,
    guardianName: row.guardian_name,
    guardianRelationship: row.guardian_relationship,
    personName: row.person_name,
    personDocument: opts.admin ? row.person_document : null,
    documentChecked: bool(row.document_checked),
    authorizationId: row.authorization_id,
    authorizedByName: row.authorized_by_name,
    guardId: row.guard_id,
    guardName: row.guard_name,
    method: row.method,
    credentialId: row.credential_id,
    override: bool(row.override),
    conflict: row.conflict,
    queued: bool(row.queued),
    note: row.note,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
  };
}

export const EVENT_ORDER = 'occurred_at DESC, created_at DESC, id DESC';

/** Recent events per child (window function), newest first, including voided ones. */
export function recentEventsByChild(db: Db, childIds: string[], perChild: number): Map<string, EventRow[]> {
  const out = new Map<string, EventRow[]>();
  if (childIds.length === 0) return out;
  const rows = all<EventRow & { rn: number }>(
    db,
    `SELECT * FROM (
       SELECT e.*, ROW_NUMBER() OVER (PARTITION BY child_id ORDER BY ${EVENT_ORDER}) AS rn
       FROM attendance_events e WHERE child_id IN (${placeholders(childIds.length)})
     ) WHERE rn <= ? ORDER BY child_id, rn`,
    ...childIds,
    perChild
  );
  for (const row of rows) {
    const list = out.get(row.child_id) ?? [];
    list.push(row);
    out.set(row.child_id, list);
  }
  return out;
}
