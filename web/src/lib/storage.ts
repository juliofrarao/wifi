/** localStorage keys used across the app (single place so nothing collides). */
export const STORAGE_KEYS = {
  token: 'creche.token',
  user: 'creche.user',
  gateMode: 'creche.gate.mode',
  gateRecent: 'creche.gate.recent',
  gateUndo: 'creche.gate.undo',
  gateHiddenAt: 'creche.gate.hiddenAt',
  updateDismissed: 'creche.updateDismissed',
} as const;

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
