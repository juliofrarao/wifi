/**
 * Reports (spec §7 admin 6): the daily report (entries, exits, pending,
 * absences with streaks, exceptions, conflicts, refusals, cancellations) and
 * the monthly frequency report (school days = civil days with ≥ 1 check-in in
 * the unit). Both reuse services/absence.ts for streaks.
 */
import { type DailyReport, type DailyReportRow, type FrequencyReport, type FrequencyRow, type Shift, civilDate, todayCivil } from '@creche/shared';
import type { Config } from '../config.js';
import { type Db, all } from '../db/index.js';
import type { ChildRow, EventRow } from '../db/rows.js';
import { EVENT_ORDER, eventToDto } from '../dto/events.js';
import { ApiError } from '../lib/errors.js';
import { civilDayRange, dayEndIso, dayRange, isValidCivilDate } from '../lib/time.js';
import { absentStreaks } from './absence.js';
import { toCsv } from './csv.js';

export interface ReportCtx {
  db: Db;
  config: Config;
}

interface ChildRef {
  id: string;
  name: string;
  className: string | null;
  shift: Shift | null;
}

const refOf = (c: ChildRow): ChildRef => ({ id: c.id, name: c.name, className: c.class_name, shift: c.shift });
const byClassAndName = (a: ChildRow, b: ChildRow) => (a.class_name ?? '').localeCompare(b.class_name ?? '', 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR');

export function dailyReport(ctx: ReportCtx, date: string, now: Date): DailyReport {
  const { db, config } = ctx;
  const tz = config.tz;
  if (!isValidCivilDate(date)) throw new ApiError('VALIDATION', 'Data inválida', { issues: [{ path: 'date', message: 'Data inválida (use AAAA-MM-DD)' }] });
  const [start, end] = civilDayRange(date, tz);
  const events = all<EventRow>(db, `SELECT * FROM attendance_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY ${EVENT_ORDER}`, start, end).reverse();
  const children = all<ChildRow>(db, 'SELECT * FROM children WHERE active = 1 AND anonymized_at IS NULL').sort(byClassAndName);
  const known = new Set(children.map((c) => c.id));
  // Inactive children with events that day still appear in the rows.
  for (const e of events) {
    if (known.has(e.child_id)) continue;
    const row = all<ChildRow>(db, 'SELECT * FROM children WHERE id = ?', e.child_id)[0];
    if (row) {
      children.push(row);
      known.add(row.id);
    }
  }
  children.sort(byClassAndName);

  const live = events.filter((e) => !e.voided_at);
  const firstCheckin = new Map<string, EventRow>();
  const lastCheckout = new Map<string, EventRow>();
  for (const e of live) {
    if (e.type === 'checkin' && !firstCheckin.has(e.child_id)) firstCheckin.set(e.child_id, e);
    if (e.type === 'checkout') {
      const current = lastCheckout.get(e.child_id);
      // A real checkout wins over an automatic closing of the same day.
      if (!current || current.method === 'auto' || e.method !== 'auto') lastCheckout.set(e.child_id, e);
    }
  }
  const rows: DailyReportRow[] = [];
  const absentIds: ChildRow[] = [];
  for (const c of children) {
    const checkin = firstCheckin.get(c.id) ?? null;
    const checkout = lastCheckout.get(c.id) ?? null;
    if (!checkin && !checkout) {
      if (c.active) absentIds.push(c);
      continue;
    }
    rows.push({
      child: refOf(c),
      checkin: checkin ? eventToDto(checkin, { admin: true }) : null,
      checkout: checkout ? eventToDto(checkout, { admin: true }) : null,
      pending: !!checkin && !checkout,
    });
  }
  // Streaks as of the end of the report day (or now, for today).
  const reportEnd = date < todayCivil(tz, now) ? new Date(dayEndIso(date, tz)) : now;
  const { streaks } = absentStreaks(db, absentIds.map((c) => c.id), { now: reportEnd, tz });
  const absent = absentIds.map((c) => ({ ...refOf(c), absentStreakDays: streaks.get(c.id) ?? 0 }));
  const dto = (list: EventRow[]) => list.map((e) => eventToDto(e, { admin: true }));
  return {
    date,
    rows,
    absent,
    overrides: dto(live.filter((e) => e.override === 1)),
    conflicts: dto(live.filter((e) => e.conflict !== null)),
    denied: dto(live.filter((e) => e.type === 'denied')),
    voided: dto(events.filter((e) => e.voided_at !== null)),
  };
}

export function isValidMonth(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12;
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function frequencyReport(ctx: ReportCtx, month: string, className: string | undefined, now: Date): FrequencyReport {
  const { db, config } = ctx;
  const tz = config.tz;
  if (!isValidMonth(month)) throw new ApiError('VALIDATION', 'Mês inválido', { issues: [{ path: 'month', message: 'Mês inválido (use AAAA-MM)' }] });
  const { from, to } = monthRange(month);
  const [start, end] = dayRange(from, to, tz);
  const checkins = all<{ child_id: string; occurred_at: string }>(
    db,
    `SELECT child_id, occurred_at FROM attendance_events WHERE type = 'checkin' AND voided_at IS NULL AND occurred_at >= ? AND occurred_at < ?`,
    start,
    end
  );
  const days = new Set<string>();
  const byChild = new Map<string, Set<string>>();
  for (const r of checkins) {
    const day = civilDate(r.occurred_at, tz);
    days.add(day);
    let s = byChild.get(r.child_id);
    if (!s) {
      s = new Set();
      byChild.set(r.child_id, s);
    }
    s.add(day);
  }
  const schoolDays = [...days].sort();
  const children = all<ChildRow>(db, 'SELECT * FROM children WHERE active = 1 AND anonymized_at IS NULL AND (? IS NULL OR class_name = ?)', className ?? null, className ?? null).sort(byClassAndName);
  const { streaks } = absentStreaks(db, children.map((c) => c.id), { now, tz });
  const rows: FrequencyRow[] = children.map((c) => {
    const createdDay = civilDate(c.created_at, tz);
    const present = byChild.get(c.id) ?? new Set<string>();
    const daysPresent = schoolDays.filter((d) => present.has(d)).length;
    const applicable = schoolDays.filter((d) => d >= createdDay || present.has(d)).length;
    const absences = Math.max(0, applicable - daysPresent);
    const percent = applicable === 0 ? 0 : Math.round((daysPresent / applicable) * 1000) / 10;
    return { child: refOf(c), daysPresent, absences, absentStreakDays: streaks.get(c.id) ?? 0, percent };
  });
  return { month, schoolDays: schoolDays.length, rows };
}

export const FREQUENCY_CSV_HEADER = ['crianca', 'turma', 'turno', 'dias_letivos', 'dias_presentes', 'faltas', 'dias_seguidos_ausente', 'percentual'];

export function frequencyCsv(report: FrequencyReport): string {
  const lines: (string | number | null)[][] = [FREQUENCY_CSV_HEADER];
  for (const r of report.rows) {
    lines.push([r.child.name, r.child.className, r.child.shift, report.schoolDays, r.daysPresent, r.absences, r.absentStreakDays, String(r.percent).replace('.', ',')]);
  }
  return toCsv(lines);
}
