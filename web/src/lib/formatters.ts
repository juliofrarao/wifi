import { civilDate, formatCivilDate, formatDate, formatDateTime, formatTime, todayCivil } from '@creche/shared';

/** Formatters bound to a time zone (plain functions, DOM-free; use useFormat() in components). */
export function makeFormatters(timeZone: string) {
  return {
    timeZone,
    /** HH:MM */
    time: (iso: string | Date | null | undefined) => (iso ? formatTime(iso, timeZone) : ''),
    /** DD/MM/YYYY */
    date: (iso: string | Date | null | undefined) => (iso ? formatDate(iso, timeZone) : ''),
    /** DD/MM/YYYY às HH:MM */
    dateTime: (iso: string | Date | null | undefined) => (iso ? formatDateTime(iso, timeZone) : ''),
    /** DD/MM */
    dayMonth: (iso: string | Date | null | undefined) => (iso ? formatDate(iso, timeZone).slice(0, 5) : ''),
    /** civil YYYY-MM-DD → DD/MM/YYYY */
    civil: (civil: string | null | undefined) => (civil ? formatCivilDate(civil) : ''),
    /** civil date of an instant */
    civilOf: (iso: string | Date) => civilDate(iso, timeZone),
    /** today's civil date */
    today: () => todayCivil(timeZone),
    /** "hoje às 07:45" / "ontem às 17:30" / "10/09 às 17:30" */
    relative: (iso: string | Date | null | undefined) => {
      if (!iso) return '';
      const day = civilDate(iso, timeZone);
      const today = todayCivil(timeZone);
      const t = formatTime(iso, timeZone);
      if (day === today) return `hoje às ${t}`;
      const yesterday = civilDate(new Date(Date.now() - 86_400_000), timeZone);
      if (day === yesterday) return `ontem às ${t}`;
      return `${formatDate(iso, timeZone).slice(0, 5)} às ${t}`;
    },
  };
}

export type Formatters = ReturnType<typeof makeFormatters>;

/** "0:32" countdown text from milliseconds. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "3 h", "45 min", "2 dias" (rounded, for banners). */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} dias`;
}
