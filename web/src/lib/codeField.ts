import { CODE_INVALID_CHARS, CODE_LENGTH, isValidCode, normalizeCode } from '@creche/shared';

export interface CodeFieldState {
  /** What to show in the input: XXXX-XXXX while typing. */
  display: string;
  /** Uppercase, letters/digits only, max 8 chars. */
  normalized: string;
  /** 8 characters typed. */
  complete: boolean;
  /** 8 characters, all from the code alphabet — auto-submit when true. */
  valid: boolean;
  /** Characters typed that can never be part of a code (0, O, 1, I, L). */
  invalidChars: string[];
}

/** Pure formatter for the typed-code field (live XXXX-XXXX). */
export function formatCodeInput(raw: string): CodeFieldState {
  const normalized = normalizeCode(raw).slice(0, CODE_LENGTH);
  const display = normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
  const invalidChars = [...new Set([...normalized].filter((ch) => CODE_INVALID_CHARS.includes(ch)))];
  const complete = normalized.length === CODE_LENGTH;
  return { display, normalized, complete, valid: complete && isValidCode(normalized), invalidChars };
}

/** Hint shown when ambiguous characters are typed. */
export function codeHint(state: CodeFieldState): string | null {
  if (state.invalidChars.length === 0) return null;
  const list = state.invalidChars.join(', ');
  return `Os códigos não usam 0, O, 1, I nem L (você digitou ${list}). Confira na carteirinha.`;
}
