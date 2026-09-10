import type { z } from 'zod';
import { ApiError } from './errors.js';

/** Parse with a zod schema; throws ApiError(VALIDATION) with details.issues. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError('VALIDATION', issues[0]?.message ?? 'Dados inválidos', { issues });
  }
  return result.data;
}

/** Coerce a query-string boolean (`true`, `1`, `sim`, `yes`). */
export function queryBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'sim', 'on'].includes(s);
}

/** Coerce a query-string integer within bounds. */
export function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function queryStr(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}
