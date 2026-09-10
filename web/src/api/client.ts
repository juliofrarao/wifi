import { ERROR_CODES, type ErrorCode } from '@creche/shared';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage';

/**
 * fetch wrapper for the /api routes.
 *
 *  - base '/api', JSON in/out, Bearer token from localStorage;
 *  - per-call timeout with AbortController (default 10 s);
 *  - typed ApiError (code/message/details/status) parsed from { error: {...} };
 *  - a 401 UNAUTHORIZED on an authenticated call clears the token and the
 *    gate directory (NOT the queue) and emits `creche:auth-expired` on window;
 *  - every successful authenticated call emits `creche:request-ok` (used by
 *    the queue worker as a drain trigger) unless `silent: true`.
 */

export const API_BASE = '/api';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Server codes plus client-side failure modes. */
export type ClientErrorCode = ErrorCode | 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ClientErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
  get isNetwork(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Human message (pt-BR) for any thrown value. */
export function describeError(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message || 'Erro inesperado';
  return 'Erro inesperado';
}

export const AUTH_EXPIRED_EVENT = 'creche:auth-expired';
export const REQUEST_OK_EVENT = 'creche:request-ok';
export const TOKEN_CHANGED_EVENT = 'creche:token-changed';

export function getToken(): string | null {
  return readString(STORAGE_KEYS.token);
}

export function setToken(token: string | null): void {
  writeString(STORAGE_KEYS.token, token);
  window.dispatchEvent(new CustomEvent(TOKEN_CHANGED_EVENT, { detail: { token } }));
}

export function clearToken(): void {
  setToken(null);
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialisable body, or FormData for multipart uploads. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Attach the Bearer token (default true). */
  auth?: boolean;
  /** Do not emit the request-ok event (internal calls such as heartbeat). */
  silent?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

const KNOWN_CODES = new Set<string>(ERROR_CODES);

async function parseError(res: Response): Promise<ApiError> {
  type ErrorPayload = { error?: { code?: string; message?: string; details?: unknown } };
  let payload: ErrorPayload | null = null;
  try {
    payload = (await res.json()) as ErrorPayload;
  } catch {
    payload = null;
  }
  const rawCode = payload?.error?.code;
  const code: ClientErrorCode = rawCode && KNOWN_CODES.has(rawCode) ? (rawCode as ErrorCode) : fallbackCode(res.status);
  const message = payload?.error?.message || defaultMessage(code, res.status);
  return new ApiError(code, message, res.status, payload?.error?.details);
}

function fallbackCode(status: number): ClientErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'BAD_RESPONSE';
}

function defaultMessage(code: ClientErrorCode, status: number): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Sessão expirada. Entre novamente.';
    case 'FORBIDDEN':
      return 'Você não tem permissão para esta ação.';
    case 'NOT_FOUND':
      return 'Não encontrado.';
    case 'RATE_LIMITED':
      return 'Muitas tentativas. Aguarde um pouco.';
    case 'INTERNAL':
      return 'Erro no servidor. Tente novamente.';
    default:
      return `Erro ${status}`;
  }
}

/** Fires the session-expired handling: clears the token and notifies listeners. */
export function handleAuthExpired(): void {
  if (getToken()) clearToken();
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/**
 * Low-level request: returns the Response (status already checked for
 * errors, 401 handled). Use for downloads / header access (ETag).
 */
export async function apiRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, query, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, auth = true, silent = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Tempo esgotado', 'TimeoutError')), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const reqHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  const token = auth ? getToken() : null;
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) {
    payload = body;
  } else if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: reqHeaders,
      body: payload,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
    if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError') {
      throw new ApiError('TIMEOUT', 'Sem resposta do servidor (tempo esgotado).', 0);
    }
    if (signal?.aborted) throw new ApiError('NETWORK', 'Requisição cancelada.', 0);
    throw new ApiError('NETWORK', 'Sem conexão com o servidor.', 0);
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onOuterAbort);

  if (res.ok || res.status === 304) {
    if (token && !silent) window.dispatchEvent(new CustomEvent(REQUEST_OK_EVENT, { detail: { path } }));
    return res;
  }
  const error = await parseError(res);
  if (res.status === 401 && token && error.code === 'UNAUTHORIZED') {
    handleAuthExpired();
  }
  throw error;
}

/** JSON request; resolves `undefined` for 204 / empty bodies. */
export async function api<T = void>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('BAD_RESPONSE', 'Resposta inválida do servidor.', res.status);
  }
}

/** Binary download (CSV, backup). */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await apiRaw(path, { ...opts, headers: { Accept: '*/*', ...(opts.headers ?? {}) }, timeoutMs: opts.timeoutMs ?? 60_000 });
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return { blob: await res.blob(), filename: match ? decodeURIComponent(match[1]) : null };
}

/** Whether the browser reports being online (best effort). */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}
