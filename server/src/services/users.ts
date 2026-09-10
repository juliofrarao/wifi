/** User lookups and inserts shared by auth, users, children and import routes. */
import { randomUUID } from 'node:crypto';
import type { Role } from '@creche/shared';
import { type Db, one, run } from '../db/index.js';
import type { UserRow } from '../db/rows.js';
import { ApiError } from '../lib/errors.js';

export function findUserByIdentifier(db: Db, identifier: string): UserRow | undefined {
  const id = identifier.trim().toLowerCase();
  if (!id) return undefined;
  return one<UserRow>(db, 'SELECT * FROM users WHERE (email = ? OR login = ?) AND anonymized_at IS NULL LIMIT 1', id, id);
}

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return one<UserRow>(db, 'SELECT * FROM users WHERE email = ? LIMIT 1', email.trim().toLowerCase());
}

export function emailInUse(db: Db, email: string, exceptId?: string): boolean {
  const row = one<{ id: string }>(db, 'SELECT id FROM users WHERE email = ? LIMIT 1', email.trim().toLowerCase());
  return !!row && row.id !== exceptId;
}

export function loginInUse(db: Db, login: string, exceptId?: string): boolean {
  const row = one<{ id: string }>(db, 'SELECT id FROM users WHERE login = ? LIMIT 1', login.trim().toLowerCase());
  return !!row && row.id !== exceptId;
}

export function assertEmailFree(db: Db, email: string | null | undefined, exceptId?: string): void {
  if (email && emailInUse(db, email, exceptId)) throw new ApiError('EMAIL_IN_USE');
}

export function assertLoginFree(db: Db, login: string | null | undefined, exceptId?: string): void {
  if (login && loginInUse(db, login, exceptId)) throw new ApiError('LOGIN_IN_USE');
}

export interface NewUser {
  /** Optional pre-generated id (import plans reference ids before inserting). */
  id?: string;
  name: string;
  email?: string | null;
  login?: string | null;
  phone?: string | null;
  role: Role;
  passwordHash?: string | null;
  pinHash?: string | null;
  now: Date;
}

export function insertUser(db: Db, u: NewUser): UserRow {
  const id = u.id ?? randomUUID();
  const iso = u.now.toISOString();
  const email = u.email ? u.email.trim().toLowerCase() : null;
  const login = u.login ? u.login.trim().toLowerCase() : null;
  if (u.role !== 'guardian' && !email && !login) throw new ApiError('VALIDATION', 'Informe e-mail ou login', { issues: [{ path: 'email', message: 'Informe e-mail ou login' }] });
  run(
    db,
    `INSERT INTO users (id, name, email, login, phone, role, password_hash, pin_hash, photo_file_id, active,
       notify_checkin_push, notify_checkin_email, last_email_error, password_set_at, anonymized_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, 0, NULL, ?, NULL, ?, ?)`,
    id,
    u.name.trim(),
    email,
    login,
    u.phone?.trim() || null,
    u.role,
    u.passwordHash ?? null,
    u.pinHash ?? null,
    u.passwordHash ? iso : null,
    iso,
    iso
  );
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)!;
}

/** Password policy (R13): ≥ 8 chars, admins ≥ 12. */
export function assertPasswordStrength(password: string, role: Role): void {
  const min = role === 'admin' ? 12 : 8;
  if (password.length < min) throw new ApiError('WEAK_PASSWORD', `A senha deve ter pelo menos ${min} caracteres`);
}
