/**
 * Environment → typed Config. Every variable listed in .env.example is parsed
 * here; defaults follow the specification. Empty strings count as "unset".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(emptyToUndefined, z.string().trim().optional());
/**
 * TRUST_PROXY: `false` (default), `true` (trust every hop — only behind a proxy that overwrites
 * X-Forwarded-For, such as Caddy), a hop count such as `1` (recommended: the nearest proxy only)
 * or a comma-separated list of proxy addresses/CIDRs (SEC-6).
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const bool = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(s);
}, z.boolean().optional());
const int = z.preprocess(emptyToUndefined, z.coerce.number().int().optional());

const EnvSchema = z.object({
  APP_URL: optStr,
  PORT: int,
  HOST: optStr,
  TRUST_PROXY: optStr,
  DATA_DIR: optStr,
  WEB_DIST: optStr,
  TZ: optStr,
  DAYCARE_NAME: optStr,
  DAYCARE_PHONE: optStr,
  CONTACT_EMAIL: optStr,
  ADMIN_NAME: optStr,
  ADMIN_EMAIL: optStr,
  ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_HOST: optStr,
  SMTP_PORT: int,
  SMTP_SECURE: bool,
  SMTP_USER: optStr,
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
  MAIL_FROM: optStr,
  SMTP_DAILY_LIMIT: int,
  VAPID_PUBLIC_KEY: optStr,
  VAPID_PRIVATE_KEY: optStr,
  VAPID_SUBJECT: optStr,
  NOTIFY_HOLD_SECONDS: int,
  SESSION_TTL_DAYS: int,
  SESSION_MAX_DAYS: int,
  OFFLINE_CHECKOUT_MAX_AGE_HOURS: int,
  BACKUP_KEEP_DAYS: int,
  RETENTION_MONTHS: int,
  LOG_LEVEL: optStr,
});

export interface SmtpConfig {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  dailyLimit: number;
}

export interface Config {
  appUrl: string;
  port: number;
  host: string;
  /** false, true, a hop count ("1") or a list of trusted proxy addresses/CIDRs (Fastify `trustProxy`). */
  trustProxy: boolean | number | string[];
  /** Absolute path. */
  dataDir: string;
  /** Absolute path (may not exist in development). */
  webDist: string;
  tz: string;
  daycareName: string;
  daycarePhone: string | null;
  contactEmail: string | null;
  admin: { name: string; email: string | null; password: string | null };
  smtp: SmtpConfig;
  vapid: { publicKey: string | null; privateKey: string | null; subject: string };
  notifyHoldSeconds: number;
  sessionTtlDays: number;
  sessionMaxDays: number;
  offlineCheckoutMaxAgeHours: number;
  backupKeepDays: number;
  retentionMonths: number;
  logLevel: string;
}

/** Password that ships in .env.example — the server refuses to create an admin with it. */
export const EXAMPLE_ADMIN_PASSWORD = 'troque-esta-senha';

/** Directory of the server package (…/server), independent of the cwd. */
export function serverRoot(): string {
  // src/config.ts → ../ ; dist/config.js → ../
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Repository root (the parent of the server package). */
export function repoRoot(): string {
  return path.resolve(serverRoot(), '..');
}

/**
 * Resolves a directory from the environment. Absolute paths are used as is.
 * Relative paths are tried against the current working directory, the server
 * package and the repository root, in that order, and the first candidate that
 * exists wins (`marker` names a file that must exist inside it, e.g.
 * `index.html` for WEB_DIST). When none exists the cwd-relative path is
 * returned (DATA_DIR is created on startup). This keeps `npm start` (cwd =
 * server/), `node server/dist/index.js` (cwd = repo root) and Docker
 * (absolute paths) all working with the same .env.
 */
export function resolveDir(raw: string, marker?: string, cwd: string = process.cwd()): string {
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const candidates = [...new Set([cwd, serverRoot(), repoRoot()].map((base) => path.resolve(base, raw)))];
  for (const candidate of candidates) {
    if (fs.existsSync(marker ? path.join(candidate, marker) : candidate)) return candidate;
  }
  return candidates[0];
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const e = parsed.data;
  const tz = e.TZ ?? 'America/Sao_Paulo';
  if (!isValidTimeZone(tz)) throw new Error(`Configuração inválida: TZ "${tz}" não é um fuso horário conhecido`);
  const dataDir = resolveDir(e.DATA_DIR ?? './data');
  const webDist = resolveDir(e.WEB_DIST ?? '../web/dist', 'index.html');
  const appUrl = (e.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  return {
    appUrl,
    port: e.PORT ?? 3000,
    host: e.HOST ?? '0.0.0.0',
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    dataDir,
    webDist,
    tz,
    daycareName: e.DAYCARE_NAME ?? 'Creche Municipal',
    daycarePhone: e.DAYCARE_PHONE ?? null,
    contactEmail: e.CONTACT_EMAIL ?? null,
    admin: {
      name: e.ADMIN_NAME ?? 'Direção',
      email: e.ADMIN_EMAIL?.toLowerCase() ?? null,
      password: e.ADMIN_PASSWORD ?? null,
    },
    smtp: {
      host: e.SMTP_HOST ?? null,
      port: e.SMTP_PORT ?? 587,
      secure: e.SMTP_SECURE ?? false,
      user: e.SMTP_USER ?? null,
      pass: e.SMTP_PASS ?? null,
      from: e.MAIL_FROM ?? 'Creche Segura <no-reply@localhost>',
      dailyLimit: e.SMTP_DAILY_LIMIT ?? 450,
    },
    vapid: {
      publicKey: e.VAPID_PUBLIC_KEY ?? null,
      privateKey: e.VAPID_PRIVATE_KEY ?? null,
      subject: e.VAPID_SUBJECT ?? (e.ADMIN_EMAIL ? `mailto:${e.ADMIN_EMAIL}` : `mailto:admin@localhost`),
    },
    notifyHoldSeconds: e.NOTIFY_HOLD_SECONDS ?? 45,
    sessionTtlDays: e.SESSION_TTL_DAYS ?? 30,
    sessionMaxDays: e.SESSION_MAX_DAYS ?? 90,
    offlineCheckoutMaxAgeHours: e.OFFLINE_CHECKOUT_MAX_AGE_HOURS ?? 12,
    backupKeepDays: e.BACKUP_KEEP_DAYS ?? 14,
    retentionMonths: e.RETENTION_MONTHS ?? 24,
    logLevel: e.LOG_LEVEL ?? 'info',
  };
}

/**
 * Loads a .env file (Node 22 built-in) without overriding variables already in
 * the environment. Looks in the cwd first, then in the repository root.
 */
export function loadDotEnv(): string | null {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(serverRoot(), '..', '.env')];
  for (const file of candidates) {
    try {
      process.loadEnvFile(file);
      return file;
    } catch {
      // not found — try the next candidate
    }
  }
  return null;
}
