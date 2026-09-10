/**
 * First-run seeding: settings (daycare info from env only when absent, VAPID
 * keys, files_secret, directory_version) and the initial admin.
 */
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { type Config, EXAMPLE_ADMIN_PASSWORD } from './config.js';
import { type Db, one, run, tx } from './db/index.js';
import { getSetting, SETTING_KEYS, setSettingIfAbsent } from './db/settings.js';
import { hashPassword, randomHex } from './lib/crypto.js';
import { audit } from './lib/audit.js';

export function seedSettings(db: Db, config: Config): void {
  tx(db, () => {
    setSettingIfAbsent(db, SETTING_KEYS.daycareName, config.daycareName);
    if (config.daycarePhone) setSettingIfAbsent(db, SETTING_KEYS.daycarePhone, config.daycarePhone);
    if (config.contactEmail) setSettingIfAbsent(db, SETTING_KEYS.contactEmail, config.contactEmail);
    setSettingIfAbsent(db, SETTING_KEYS.directoryVersion, '1');
    setSettingIfAbsent(db, SETTING_KEYS.filesSecret, randomHex(32));
    if (!getSetting(db, SETTING_KEYS.vapidPublicKey) || !getSetting(db, SETTING_KEYS.vapidPrivateKey)) {
      const keys = config.vapid.publicKey && config.vapid.privateKey ? { publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey } : webpush.generateVAPIDKeys();
      setSettingIfAbsent(db, SETTING_KEYS.vapidPublicKey, keys.publicKey);
      setSettingIfAbsent(db, SETTING_KEYS.vapidPrivateKey, keys.privateKey);
    }
    setSettingIfAbsent(db, SETTING_KEYS.vapidSubject, config.vapid.subject);
  });
}

export function filesSecretOf(db: Db): string {
  const secret = getSetting(db, SETTING_KEYS.filesSecret);
  if (!secret) throw new Error('settings.files_secret ausente — chame seedSettings() antes');
  return secret;
}

export class StartupError extends Error {}

/**
 * Create the initial admin from ADMIN_* when no admin exists. Throws
 * StartupError (refuse to start) when the password is the example one or
 * shorter than 12 characters.
 */
export async function ensureInitialAdmin(db: Db, config: Config, now: Date = new Date()): Promise<{ created: boolean; id?: string }> {
  const existing = one<{ id: string }>(db, `SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existing) return { created: false };
  const { email, password, name } = config.admin;
  if (!email) throw new StartupError('Nenhum administrador existe e ADMIN_EMAIL não foi informado.');
  if (!password || password === EXAMPLE_ADMIN_PASSWORD || password.length < 12) {
    throw new StartupError('ADMIN_PASSWORD precisa ter pelo menos 12 caracteres e ser diferente da senha do exemplo (troque-esta-senha).');
  }
  const id = randomUUID();
  const iso = now.toISOString();
  run(
    db,
    `INSERT INTO users (id, name, email, login, phone, role, password_hash, pin_hash, photo_file_id, active,
       notify_checkin_push, notify_checkin_email, last_email_error, password_set_at, anonymized_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'admin', ?, NULL, NULL, 1, 1, 0, NULL, ?, NULL, ?, ?)`,
    id,
    name,
    email.toLowerCase(),
    await hashPassword(password),
    iso,
    iso,
    iso
  );
  audit(db, null, 'user.create', 'user', id, { role: 'admin', source: 'env' }, null, now);
  return { created: true, id };
}
