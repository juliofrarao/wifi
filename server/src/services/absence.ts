/**
 * Absence streaks. A "school day" is a civil day (daycare TZ) with at least
 * one non-voided checkin in the unit. A child's streak is the number of the
 * most recent school days, counted backwards, without a checkin for that
 * child (only days on/after the child's registration count).
 * Reused by admin stats (S1) and by reports (S2).
 */
import { civilDate } from '@creche/shared';
import { type Db, all } from '../db/index.js';
import { DAY_MS } from '../lib/time.js';

export interface AbsenceOptions {
  now: Date;
  tz: string;
  /** How many days back to look (default 60). */
  lookbackDays?: number;
}

export interface AbsenceResult {
  /** Civil school days, newest first. */
  schoolDays: string[];
  /** child id → consecutive absent school days (0 when present on the latest school day). */
  streaks: Map<string, number>;
}

export function absentStreaks(db: Db, childIds: string[], opts: AbsenceOptions): AbsenceResult {
  const lookback = opts.lookbackDays ?? 60;
  const since = new Date(opts.now.getTime() - lookback * DAY_MS).toISOString();
  // Upper bound: reports ask for streaks "as of" a past day (S2), so later check-ins must not count.
  const rows = all<{ child_id: string; occurred_at: string }>(
    db,
    `SELECT child_id, occurred_at FROM attendance_events WHERE type = 'checkin' AND voided_at IS NULL AND occurred_at >= ? AND occurred_at <= ?`,
    since,
    opts.now.toISOString()
  );
  const daysSet = new Set<string>();
  const byChild = new Map<string, Set<string>>();
  for (const r of rows) {
    const day = civilDate(r.occurred_at, opts.tz);
    daysSet.add(day);
    let s = byChild.get(r.child_id);
    if (!s) {
      s = new Set();
      byChild.set(r.child_id, s);
    }
    s.add(day);
  }
  const schoolDays = [...daysSet].sort().reverse();
  const created = new Map<string, string>();
  if (childIds.length > 0) {
    for (const r of all<{ id: string; created_at: string }>(db, 'SELECT id, created_at FROM children')) {
      created.set(r.id, civilDate(r.created_at, opts.tz));
    }
  }
  const streaks = new Map<string, number>();
  for (const id of childIds) {
    const present = byChild.get(id);
    const createdDay = created.get(id) ?? '0000-00-00';
    let streak = 0;
    for (const day of schoolDays) {
      if (day < createdDay) break;
      if (present?.has(day)) break;
      streak++;
    }
    streaks.set(id, streak);
  }
  return { schoolDays, streaks };
}
