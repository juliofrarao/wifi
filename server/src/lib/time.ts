/**
 * Time helpers. Instants are ISO 8601 UTC strings with milliseconds and `Z`;
 * civil dates are YYYY-MM-DD in the daycare time zone (never derived from
 * toISOString().slice(0, 10)).
 */
import { addDays, civilDate, todayCivil as sharedTodayCivil } from '@creche/shared';

export { addDays, civilDate };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function todayCivil(tz: string, now: Date = new Date()): string {
  return sharedTodayCivil(tz, now);
}

/** Normalize any parseable date-time (with offset) to ISO UTC with ms + Z. */
export function normalizeIso(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) throw new Error(`Data/hora inválida: ${String(input)}`);
  return d.toISOString();
}

export function isValidCivilDate(civil: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civil)) return false;
  const [y, m, d] = civil.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(instant: Date, tz: string): Parts {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) between the zone's wall clock and UTC at a given instant. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/** Instant of a wall-clock time in a time zone (handles DST transitions on a second pass). */
export function zonedToUtc(tz: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset1 = tzOffsetMs(new Date(guess), tz);
  let result = guess - offset1;
  const offset2 = tzOffsetMs(new Date(result), tz);
  if (offset2 !== offset1) result = guess - offset2;
  return new Date(result);
}

/** Instant (ISO) of civil `YYYY-MM-DD 00:00:00.000` in the zone. */
export function dayStartIso(civil: string, tz: string): string {
  const [y, m, d] = civil.split('-').map(Number);
  return zonedToUtc(tz, y, m, d).toISOString();
}

/** Instant (ISO) of civil `YYYY-MM-DD 23:59:59.000` in the zone (used for automatic closings). */
export function dayEndIso(civil: string, tz: string): string {
  const [y, m, d] = civil.split('-').map(Number);
  return zonedToUtc(tz, y, m, d, 23, 59, 59, 0).toISOString();
}

/** Inclusive civil range `from..to` → half-open instant range `[start, end)`. */
export function dayRange(from: string, to: string, tz: string): [string, string] {
  return [dayStartIso(from, tz), dayStartIso(addDays(to, 1), tz)];
}

/** `[start, end)` of a single civil day. */
export function civilDayRange(civil: string, tz: string): [string, string] {
  return dayRange(civil, civil, tz);
}

/** Subtract calendar months from an instant (UTC arithmetic) and return ISO. */
export function minusMonthsIso(now: Date, months: number): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

export function plusMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

export function plusMsIso(now: Date, ms: number): string {
  return plusMs(now, ms).toISOString();
}
