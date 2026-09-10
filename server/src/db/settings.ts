/**
 * Key/value settings. Seeded on first run (see bootstrap.ts); afterwards the
 * admin panel wins over the environment.
 */
import type { Db } from './index.js';

export const SETTING_KEYS = {
  daycareName: 'daycare_name',
  daycarePhone: 'daycare_phone',
  contactEmail: 'contact_email',
  vapidPublicKey: 'vapid_public_key',
  vapidPrivateKey: 'vapid_private_key',
  vapidSubject: 'vapid_subject',
  filesSecret: 'files_secret',
  directoryVersion: 'directory_version',
  lastBackupAt: 'last_backup_at',
  demoData: 'demo_data',
  /** Civil day (in TZ) when the admins were last warned about the e-mail quota (S2). */
  quotaWarnedDay: 'quota_warned_day',
  /** Prefix of the per-day counter of e-mails sent outside the notifications table (invites, resets, tests). */
  outboundEmailsPrefix: 'emails_sent:',
} as const;

/** Count one outbound e-mail (invite/reset/test) for the daily SMTP quota (QUOTA-1). */
export function countOutboundEmail(db: Db, civilDay: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
  ).run(`${SETTING_KEYS.outboundEmailsPrefix}${civilDay}`);
}

/** E-mails sent on a civil day outside the notifications table. */
export function outboundEmailsOn(db: Db, civilDay: string): number {
  return getSettingInt(db, `${SETTING_KEYS.outboundEmailsPrefix}${civilDay}`, 0);
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSettingInt(db: Db, key: string, fallback = 0): number {
  const v = getSetting(db, key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(db: Db, key: string, fallback = false): boolean {
  const v = getSetting(db, key);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

/** Set only when absent (first-run seeding). Returns true when it wrote. */
export function setSettingIfAbsent(db: Db, key: string, value: string): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return res.changes > 0;
}

/** Increment `directory_version` (call after any mutation that affects the gate directory). */
export function bumpDirectoryVersion(db: Db): number {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
  ).run(SETTING_KEYS.directoryVersion);
  return getSettingInt(db, SETTING_KEYS.directoryVersion, 1);
}

export function getDirectoryVersion(db: Db): number {
  return getSettingInt(db, SETTING_KEYS.directoryVersion, 1);
}
