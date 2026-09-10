/** Vibration patterns (spec §7): read, checkin, checkout, error. */
export const VIBRATE = {
  read: [60],
  checkin: [80, 40, 80],
  checkout: [200],
  error: [400, 100, 400],
} as const;

export function vibrate(pattern: number | readonly number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern as number | number[]);
    }
  } catch {
    /* unsupported */
  }
}
