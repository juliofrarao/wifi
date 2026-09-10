import type { ZodTypeAny, z } from 'zod';
import { describeError, isApiError } from '../api/client';

/** Field errors keyed by zod path ("email", "events.0.childId"). */
export type FieldErrors = Record<string, string>;

interface IssueLike {
  path?: string | (string | number)[];
  message?: string;
}

/** Extracts `details.issues` from a VALIDATION ApiError into a path → message map. */
export function issuesFromError(err: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!isApiError(err) || err.code !== 'VALIDATION') return out;
  const details = err.details as { issues?: IssueLike[] } | undefined;
  for (const issue of details?.issues ?? []) {
    const path = Array.isArray(issue.path) ? issue.path.join('.') : (issue.path ?? '');
    if (!(path in out) && issue.message) out[path] = issue.message;
  }
  return out;
}

/**
 * Human message for a failed request: for VALIDATION errors the issue
 * messages (pt-BR, from the shared zod schemas) are joined; otherwise the
 * ApiError message.
 */
export function formError(err: unknown): string {
  const issues = Object.values(issuesFromError(err));
  if (issues.length > 0) return issues.join(' · ');
  return describeError(err);
}

export type ValidationResult<T> = { ok: true; data: T; errors: FieldErrors } | { ok: false; data: null; errors: FieldErrors; first: string };

/** Runs a zod schema client-side and mirrors the server error shape. */
export function validateWith<S extends ZodTypeAny>(schema: S, values: unknown): ValidationResult<z.infer<S>> {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data as z.infer<S>, errors: {} };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (!(path in errors)) errors[path] = issue.message;
  }
  const first = result.error.issues[0]?.message ?? 'Dados inválidos';
  return { ok: false, data: null, errors, first };
}

/** "" → null (optional text inputs). */
export function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** "" → undefined (optional fields that must be omitted, not nulled). */
export function emptyToUndefined(value: string | null | undefined): string | undefined {
  const v = emptyToNull(value);
  return v === null ? undefined : v;
}
