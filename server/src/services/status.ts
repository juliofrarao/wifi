/**
 * Child status (spec §3): derived from the last non-voided checkin/checkout
 * ordered by occurred_at DESC, created_at DESC, id DESC. `stale` = present
 * since a civil day earlier than today (daycare time zone).
 */
import { type ChildStatus, civilDate, todayCivil } from '@creche/shared';
import { type Db, all, one, placeholders } from '../db/index.js';
import type { EventRow } from '../db/rows.js';
import { EVENT_ORDER, eventToDto } from '../dto/events.js';

export interface StatusCtx {
  now: Date;
  tz: string;
  /** Whether the DTO of the last event may carry person_document. */
  admin: boolean;
}

export function deriveStatus(last: EventRow | undefined | null, ctx: StatusCtx): ChildStatus {
  if (!last) return { present: false, since: null, lastEvent: null, stale: false };
  const present = last.type === 'checkin';
  const since = present ? last.occurred_at : null;
  const stale = present && civilDate(last.occurred_at, ctx.tz) < todayCivil(ctx.tz, ctx.now);
  return { present, since, lastEvent: eventToDto(last, { admin: ctx.admin }), stale };
}

/** Last status-relevant event of one child. */
export function lastStatusEvent(db: Db, childId: string): EventRow | undefined {
  return one<EventRow>(
    db,
    `SELECT * FROM attendance_events WHERE child_id = ? AND voided_at IS NULL AND type IN ('checkin','checkout')
     ORDER BY ${EVENT_ORDER} LIMIT 1`,
    childId
  );
}

/** Last status-relevant event for many children in one query. */
export function lastStatusEvents(db: Db, childIds: string[]): Map<string, EventRow> {
  const out = new Map<string, EventRow>();
  if (childIds.length === 0) return out;
  // SQLite caps bound parameters (32766 by default); chunk defensively.
  const CHUNK = 900;
  for (let i = 0; i < childIds.length; i += CHUNK) {
    const ids = childIds.slice(i, i + CHUNK);
    const rows = all<EventRow & { rn: number }>(
      db,
      `SELECT * FROM (
         SELECT e.*, ROW_NUMBER() OVER (PARTITION BY child_id ORDER BY ${EVENT_ORDER}) AS rn
         FROM attendance_events e
         WHERE child_id IN (${placeholders(ids.length)}) AND voided_at IS NULL AND type IN ('checkin','checkout')
       ) WHERE rn = 1`,
      ...ids
    );
    for (const row of rows) out.set(row.child_id, row);
  }
  return out;
}

export function childStatus(db: Db, childId: string, ctx: StatusCtx): ChildStatus {
  return deriveStatus(lastStatusEvent(db, childId), ctx);
}

export function childStatuses(db: Db, childIds: string[], ctx: StatusCtx): Map<string, ChildStatus> {
  const last = lastStatusEvents(db, childIds);
  const out = new Map<string, ChildStatus>();
  for (const id of childIds) out.set(id, deriveStatus(last.get(id), ctx));
  return out;
}

/** Ids of active children currently present, split into fresh vs stale. */
export function presentChildren(db: Db, ctx: StatusCtx): { present: string[]; stale: string[] } {
  const ids = all<{ id: string }>(db, 'SELECT id FROM children WHERE active = 1').map((r) => r.id);
  const statuses = childStatuses(db, ids, ctx);
  const present: string[] = [];
  const stale: string[] = [];
  for (const [id, s] of statuses) {
    if (!s.present) continue;
    if (s.stale) stale.push(id);
    else present.push(id);
  }
  return { present, stale };
}
