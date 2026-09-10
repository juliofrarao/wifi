/**
 * Civil date + wall-clock time in a time zone → ISO instant.
 * Pure (Intl only) so it can be unit tested; used by "Lançar folha".
 */

function wallClockAsUtc(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}

/** Zone offset (ms, east positive) in effect at a UTC instant. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  return wallClockAsUtc(utcMs, timeZone) - utcMs;
}

/**
 * `civil` = YYYY-MM-DD, `time` = HH:MM (or HH:MM:SS). Returns the ISO UTC
 * instant of that wall-clock time in `timeZone` (DST handled by iteration).
 */
export function zonedToIso(civil: string, time: string, timeZone: string): string {
  const [y, m, d] = civil.split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - zoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

/** Whether `time` looks like HH:MM (24 h). */
export function isValidTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

/** First and last civil day of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
