/**
 * Test harness: in-memory database, fake mailer/push, recording notifier and a
 * controllable clock. Everything goes through app.inject().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { EventType, Method, Relationship, Role } from '@creche/shared';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { type Db, one, openDb, run } from '../src/db/index.js';
import type { ChildRow, CredentialRow, LinkRow, UserRow } from '../src/db/rows.js';
import { hashPassword } from '../src/lib/crypto.js';
import { type FakeMailer, createFakeMailer } from '../src/services/email.js';
import { type RecordingNotifier, createNotifier, withRecording } from '../src/services/notifications/index.js';
import { type FakePush, createFakePush } from '../src/services/push.js';
import { insertUser } from '../src/services/users.js';
import { insertCredential } from '../src/routes/credentials.js';

export const TZ = 'America/Sao_Paulo';
/** 2026-09-10 09:00 in São Paulo. */
export const START = '2026-09-10T12:00:00.000Z';

export interface Clock {
  now(): Date;
  set(iso: string): void;
  advance(ms: number): void;
}

export function createClock(startIso = START): Clock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  mailer: FakeMailer;
  push: FakePush;
  notifier: RecordingNotifier;
  clock: Clock;
  close(): Promise<void>;
}

export interface TestOptions {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
  env?: Record<string, string>;
}

export async function createTestApp(options: TestOptions = {}): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creche-test-'));
  const config = loadConfig({
    APP_URL: 'https://creche.test',
    DATA_DIR: dataDir,
    WEB_DIST: path.join(dataDir, 'no-web-dist'),
    TZ,
    DAYCARE_NAME: 'Creche Teste',
    DAYCARE_PHONE: '(11) 4002-8922',
    CONTACT_EMAIL: 'contato@creche.test',
    LOG_LEVEL: 'silent',
    ...options.env,
  });
  const db = openDb(':memory:');
  const mailer = createFakeMailer(options.emailEnabled ?? true);
  const push = createFakePush(options.pushEnabled ?? true);
  const clock = createClock();
  // Real notifier (writes notification rows) wrapped so tests can also assert on the calls.
  const notifier = withRecording(createNotifier({ db, config, now: clock.now, emailEnabled: () => mailer.enabled, pushEnabled: () => push.enabled() }));
  const app = buildApp({ db, config, mailer, push, notifier, now: clock.now }, { logger: false });
  await app.ready();
  return {
    app,
    db,
    config,
    mailer,
    push,
    notifier,
    clock,
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures (direct DB inserts — fast and independent of the routes under test)
// ---------------------------------------------------------------------------

export interface UserSpec {
  role: Role;
  name?: string;
  email?: string | null;
  login?: string | null;
  phone?: string | null;
  password?: string | null;
  pin?: string | null;
  active?: boolean;
}

let seq = 0;
const next = () => ++seq;

export async function createUser(t: TestApp, spec: UserSpec): Promise<UserRow> {
  const n = next();
  const name = spec.name ?? `${spec.role === 'admin' ? 'Admin' : spec.role === 'guard' ? 'Vigilante' : 'Responsável'} ${n}`;
  const email = spec.email === undefined ? (spec.role === 'guard' ? null : `user${n}@creche.test`) : spec.email;
  const login = spec.login === undefined ? (spec.role === 'guard' ? `guard${n}` : null) : spec.login;
  const user = insertUser(t.db, {
    name,
    email,
    login,
    phone: spec.phone ?? null,
    role: spec.role,
    passwordHash: spec.password ? await hashPassword(spec.password) : null,
    pinHash: spec.pin ? await hashPassword(spec.pin) : null,
    now: t.clock.now(),
  });
  if (spec.active === false) run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', user.id);
  return one<UserRow>(t.db, 'SELECT * FROM users WHERE id = ?', user.id)!;
}

export const ADMIN_PASSWORD = 'senha-admin-forte-123';
export const GUARD_PASSWORD = 'senha-guard-1';
export const GUARDIAN_PASSWORD = 'senha-resp-1';

export const createAdmin = (t: TestApp, spec: Partial<UserSpec> = {}) => createUser(t, { role: 'admin', password: ADMIN_PASSWORD, ...spec });
export const createGuard = (t: TestApp, spec: Partial<UserSpec> = {}) => createUser(t, { role: 'guard', password: GUARD_PASSWORD, pin: '1234', ...spec });
export const createGuardian = (t: TestApp, spec: Partial<UserSpec> = {}) => createUser(t, { role: 'guardian', password: GUARDIAN_PASSWORD, ...spec });

export interface ChildSpec {
  name?: string;
  className?: string | null;
  shift?: 'manha' | 'tarde' | 'integral' | null;
  birthDate?: string | null;
  gateAlert?: string | null;
  notes?: string | null;
  active?: boolean;
  consentAt?: string | null;
}

export function createChild(t: TestApp, spec: ChildSpec = {}): ChildRow {
  const id = randomUUID();
  const iso = t.clock.now().toISOString();
  run(
    t.db,
    `INSERT INTO children (id, name, birth_date, class_name, shift, gate_alert, notes, photo_file_id, active, deactivated_at,
       consent_at, consent_by_name, consent_relationship, anonymized_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    id,
    spec.name ?? `Criança ${next()}`,
    spec.birthDate ?? '2022-05-10',
    spec.className === undefined ? 'Maternal I' : spec.className,
    spec.shift === undefined ? 'manha' : spec.shift,
    spec.gateAlert ?? null,
    spec.notes ?? null,
    spec.active === false ? 0 : 1,
    spec.active === false ? iso : null,
    spec.consentAt === undefined ? '2026-02-01' : spec.consentAt,
    iso,
    iso
  );
  return one<ChildRow>(t.db, 'SELECT * FROM children WHERE id = ?', id)!;
}

export interface LinkSpec {
  relationship?: Relationship;
  canPickup?: boolean;
  isPrimary?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
}

export function link(t: TestApp, childId: string, userId: string, spec: LinkSpec = {}): LinkRow {
  const id = randomUUID();
  const iso = t.clock.now().toISOString();
  run(
    t.db,
    `INSERT INTO child_guardians (id, child_id, user_id, relationship, can_pickup, is_primary, valid_from, valid_until, blocked, blocked_reason,
       created_by, created_at, updated_by, updated_at, removed_at, removed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL)`,
    id,
    childId,
    userId,
    spec.relationship ?? 'mae',
    spec.canPickup === false ? 0 : 1,
    spec.isPrimary ? 1 : 0,
    spec.validFrom ?? null,
    spec.validUntil ?? null,
    spec.blocked ? 1 : 0,
    spec.blockedReason ?? null,
    iso,
    iso
  );
  return one<LinkRow>(t.db, 'SELECT * FROM child_guardians WHERE id = ?', id)!;
}

export function createCredential(t: TestApp, ownerType: 'guardian' | 'child', ownerId: string, opts: { nfcUid?: string; label?: string } = {}): CredentialRow {
  return insertCredential(t.db, { ownerType, ownerId, nfcUid: opts.nfcUid ?? null, label: opts.label ?? null, actorId: null, now: t.clock.now() });
}

export interface EventSpec {
  childId: string;
  type: EventType;
  guardId: string;
  guardianId?: string | null;
  personName?: string | null;
  occurredAt?: string;
  method?: Method;
  override?: boolean;
  conflict?: 'already_present' | 'already_out' | null;
  voidedAt?: string | null;
  note?: string | null;
}

export function insertEvent(t: TestApp, spec: EventSpec): string {
  const id = randomUUID();
  const child = one<ChildRow>(t.db, 'SELECT * FROM children WHERE id = ?', spec.childId)!;
  const guard = one<UserRow>(t.db, 'SELECT * FROM users WHERE id = ?', spec.guardId)!;
  const guardian = spec.guardianId ? one<UserRow>(t.db, 'SELECT * FROM users WHERE id = ?', spec.guardianId) : null;
  const occurredAt = spec.occurredAt ?? t.clock.now().toISOString();
  run(
    t.db,
    `INSERT INTO attendance_events (id, client_id, batch_id, child_id, child_name, type, guardian_id, guardian_name, guardian_relationship,
       person_name, person_document, document_checked, authorization_id, authorized_by_name, guard_id, guard_name, method, credential_id,
       override, conflict, queued, directory_at, note, occurred_at, created_at, voided_at, voided_by, void_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, ?, ?, ?, NULL, NULL)`,
    id,
    randomUUID(),
    randomUUID(),
    child.id,
    child.name,
    spec.type,
    guardian?.id ?? null,
    guardian?.name ?? null,
    guardian ? 'mae' : null,
    guardian ? null : (spec.personName ?? 'Pessoa Teste'),
    guard.id,
    guard.name,
    spec.method ?? 'search',
    spec.override ? 1 : 0,
    spec.conflict ?? null,
    spec.note ?? null,
    occurredAt,
    occurredAt,
    spec.voidedAt ?? null
  );
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
}

export async function request<T = any>(t: TestApp, opts: InjectOptions & { token?: string | null }): Promise<Res<T>> {
  const { token, ...rest } = opts;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (rest.payload !== undefined && !headers['content-type'] && !Buffer.isBuffer(rest.payload) && typeof rest.payload !== 'string') {
    headers['content-type'] = 'application/json';
    rest.payload = JSON.stringify(rest.payload);
  }
  const res = await t.app.inject({ ...rest, headers });
  let body: unknown = null;
  const ct = String(res.headers['content-type'] ?? '');
  if (ct.includes('application/json')) {
    try {
      body = res.json();
    } catch {
      body = null;
    }
  } else if (ct.startsWith('text/')) {
    body = res.body;
  }
  return { status: res.statusCode, body: body as T, headers: res.headers as Res['headers'], raw: res.rawPayload };
}

export const get = <T = any>(t: TestApp, url: string, token?: string | null) => request<T>(t, { method: 'GET', url, token });
export const post = <T = any>(t: TestApp, url: string, payload?: unknown, token?: string | null) => request<T>(t, { method: 'POST', url, payload, token });
export const put = <T = any>(t: TestApp, url: string, payload?: unknown, token?: string | null) => request<T>(t, { method: 'PUT', url, payload, token });
export const patch = <T = any>(t: TestApp, url: string, payload?: unknown, token?: string | null) => request<T>(t, { method: 'PATCH', url, payload, token });
export const del = <T = any>(t: TestApp, url: string, token?: string | null) => request<T>(t, { method: 'DELETE', url, token });

export async function login(t: TestApp, identifier: string, password: string): Promise<string> {
  const res = await post<{ token: string }>(t, '/api/auth/login', { identifier, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Build a multipart/form-data payload for app.inject. */
export function multipart(parts: { name: string; data: Buffer | string; filename?: string; contentType?: string }[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----creche${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.filename || p.contentType) head += `Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A tiny but valid-looking JPEG (magic bytes + padding). */
export function fakeJpeg(size = 256): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).copy(buf);
  buf[size - 2] = 0xff;
  buf[size - 1] = 0xd9;
  return buf;
}

export function fakePng(size = 128): Buffer {
  const buf = Buffer.alloc(size, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

export function tokenFromUrl(url: string): string {
  return url.split('/').pop()!;
}
