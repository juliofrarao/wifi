/**
 * `npm run seed` / `node dist/seed.js` — deterministic demonstration data
 * (spec §12): admin admin@demo.local / demo-admin-123, guards carlos (PIN 1234)
 * and ana (PIN 5678) with password demo-guard-123, 3 classes, 12 children
 * (two sibling pairs, one stale since yesterday, one without photo, one
 * expired link, one canPickup=false, one blocked), 20 guardians (some without
 * e-mail/password; maria@demo.local / demo-maria-123 with two children),
 * fixed card codes (AAAA-2222 = Maria), 5 days of events, placeholder photos.
 *
 * Every seed row has an id starting with SEED_PREFIX so `--clean` removes only
 * demo data. Refuses to run on a database with real data unless `--force`.
 * Sets settings.demo_data = 1 (the "DADOS DE DEMONSTRAÇÃO" banner).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CODE_ALPHABET, type EventType, type Method, type Relationship, type Shift, civilDate, formatCode, todayCivil } from '@creche/shared';
import { seedSettings } from './bootstrap.js';
import { type Config, loadConfig, loadDotEnv } from './config.js';
import { type Db, all, one, openDb, run, tx } from './db/index.js';
import { bumpDirectoryVersion, SETTING_KEYS, setSetting } from './db/settings.js';
import { audit } from './lib/audit.js';
import { hashPassword } from './lib/crypto.js';
import { deleteFile, storePhoto } from './lib/photos.js';
import { avatarPng } from './lib/png.js';
import { DAY_MS, MINUTE_MS, zonedParts, zonedToUtc } from './lib/time.js';
import { insertEventRow } from './services/attendance.js';
import { createNotifier } from './services/notifications/fanout.js';
import { insertUser } from './services/users.js';

export const SEED_PREFIX = 'd3a0d3a0-';
const NAMESPACE = 'creche-segura-demo:';

/** Deterministic UUID v4-shaped id for a seed key (prefix marks it as demo data). */
export function seedId(key: string): string {
  const h = createHash('sha256').update(NAMESPACE + key).digest('hex');
  return `${SEED_PREFIX}${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(8, 11)}-${h.slice(11, 23)}`;
}

/** Small deterministic hash for times. */
function h32(key: string): number {
  return createHash('sha256').update(NAMESPACE + key).digest().readUInt32BE(0);
}

export const DEMO_ADMIN = { email: 'admin@demo.local', password: 'demo-admin-123', name: 'Direção (demonstração)' };
export const DEMO_GUARD_PASSWORD = 'demo-guard-123';
export const DEMO_GUARDS = [
  { key: 'carlos', name: 'Carlos Mendes', login: 'carlos', pin: '1234' },
  { key: 'ana', name: 'Ana Ribeiro', login: 'ana', pin: '5678' },
];

const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, ''); // 23 letters
const DIGITS = '23456789';
/** Guardian i → AAAA2222, BBBB3333, …; child j → AAAA6666, BBBB7777, … (never collide). */
export function guardianCode(i: number): string {
  return LETTERS[i % LETTERS.length].repeat(4) + DIGITS[i % DIGITS.length].repeat(4);
}
export function childCode(j: number): string {
  return LETTERS[j % LETTERS.length].repeat(4) + DIGITS[(j + 4) % DIGITS.length].repeat(4);
}
export const DEMO_REVOKED_CODE = 'AAAA9999';

interface GuardianSpec {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  password: string | null;
  photo: boolean;
  nfcUid?: string;
}

interface LinkSpec {
  guardian: string;
  relationship: Relationship;
  canPickup?: boolean;
  isPrimary?: boolean;
  validUntil?: string | null;
  blocked?: boolean;
  blockedReason?: string;
}

interface ChildSpec {
  key: string;
  name: string;
  birthDate: string;
  className: string;
  shift: Shift;
  gateAlert?: string;
  notes?: string;
  photo: boolean;
  consent: boolean;
  links: LinkSpec[];
  nfcUid?: string;
}

export const DEMO_CLASSES = ['Berçário II', 'Maternal I', 'Maternal II'];

export const DEMO_GUARDIANS: GuardianSpec[] = [
  { key: 'maria', name: 'Maria Silva', email: 'maria@demo.local', phone: '(11) 91234-0001', password: 'demo-maria-123', photo: true, nfcUid: '04a224c2d61e80' },
  { key: 'joao', name: 'João Souza', email: 'joao@demo.local', phone: '(11) 91234-0002', password: null, photo: true },
  { key: 'fernanda', name: 'Fernanda Oliveira', email: 'fernanda@demo.local', phone: '(11) 91234-0003', password: 'demo-fernanda-123', photo: true, nfcUid: '04b3c5d7e9f180' },
  { key: 'ricardo', name: 'Ricardo Oliveira', email: 'ricardo@demo.local', phone: '(11) 91234-0004', password: null, photo: true },
  { key: 'patricia', name: 'Patrícia Santos', email: 'patricia@demo.local', phone: '(11) 91234-0005', password: 'demo-patricia-123', photo: true },
  { key: 'roberto', name: 'Roberto Santos', email: null, phone: '(11) 91234-0006', password: null, photo: true },
  { key: 'camila', name: 'Camila Pereira', email: 'camila@demo.local', phone: '(11) 91234-0007', password: 'demo-camila-123', photo: true },
  { key: 'eduardo', name: 'Eduardo Pereira', email: null, phone: null, password: null, photo: false },
  { key: 'aline', name: 'Aline Costa', email: 'aline@demo.local', phone: '(11) 91234-0009', password: 'demo-aline-123', photo: true },
  { key: 'renata', name: 'Renata Costa', email: 'renata@demo.local', phone: '(11) 91234-0010', password: null, photo: true },
  { key: 'beatriz', name: 'Beatriz Almeida', email: 'beatriz@demo.local', phone: '(11) 91234-0011', password: 'demo-beatriz-123', photo: true },
  { key: 'marcos', name: 'Marcos Almeida', email: 'marcos@demo.local', phone: '(11) 91234-0012', password: null, photo: true },
  { key: 'claudia', name: 'Cláudia Ferreira', email: 'claudia@demo.local', phone: '(11) 91234-0013', password: 'demo-claudia-123', photo: true },
  { key: 'paulo', name: 'Paulo Ferreira', email: 'paulo@demo.local', phone: '(11) 91234-0014', password: null, photo: true },
  { key: 'juliana', name: 'Juliana Rodrigues', email: 'juliana@demo.local', phone: '(11) 91234-0015', password: 'demo-juliana-123', photo: true },
  { key: 'zelia', name: 'Zélia Rodrigues', email: null, phone: '(11) 91234-0016', password: null, photo: true },
  { key: 'simone', name: 'Simone Lima', email: 'simone@demo.local', phone: '(11) 91234-0017', password: 'demo-simone-123', photo: true },
  { key: 'antonio', name: 'Antônio Lima', email: 'antonio@demo.local', phone: '(11) 91234-0018', password: null, photo: true },
  { key: 'vanessa', name: 'Vanessa Martins', email: null, phone: null, password: null, photo: false },
  { key: 'sergio', name: 'Sérgio Martins', email: 'sergio@demo.local', phone: '(11) 91234-0020', password: null, photo: true },
];

export function demoChildren(today: string): ChildSpec[] {
  const yesterday = civilAdd(today, -1);
  return [
    { key: 'ana', name: 'Ana Souza', birthDate: '2022-03-14', className: 'Maternal I', shift: 'manha', photo: true, consent: true, nfcUid: '0412ab34cd56ef', links: [{ guardian: 'maria', relationship: 'mae', isPrimary: true }, { guardian: 'joao', relationship: 'pai' }] },
    { key: 'pedro', name: 'Pedro Souza', birthDate: '2024-01-22', className: 'Berçário II', shift: 'integral', photo: true, consent: true, links: [{ guardian: 'maria', relationship: 'mae', isPrimary: true }, { guardian: 'joao', relationship: 'pai' }] },
    { key: 'lucas', name: 'Lucas Oliveira', birthDate: '2021-09-02', className: 'Maternal II', shift: 'tarde', photo: true, consent: true, links: [{ guardian: 'fernanda', relationship: 'mae', isPrimary: true }, { guardian: 'ricardo', relationship: 'pai' }] },
    { key: 'julia', name: 'Júlia Oliveira', birthDate: '2023-05-30', className: 'Maternal I', shift: 'manha', photo: true, consent: true, links: [{ guardian: 'fernanda', relationship: 'mae', isPrimary: true }, { guardian: 'ricardo', relationship: 'pai' }] },
    { key: 'gabriel', name: 'Gabriel Santos', birthDate: '2022-07-19', className: 'Maternal II', shift: 'tarde', photo: true, consent: true, notes: 'Saída de ontem não registrada (demonstração de pendência)', links: [{ guardian: 'patricia', relationship: 'mae', isPrimary: true }, { guardian: 'roberto', relationship: 'avoh' }] },
    { key: 'sofia', name: 'Sofia Pereira', birthDate: '2023-11-08', className: 'Berçário II', shift: 'integral', photo: false, consent: false, links: [{ guardian: 'camila', relationship: 'mae', isPrimary: true }, { guardian: 'eduardo', relationship: 'pai' }] },
    { key: 'miguel', name: 'Miguel Costa', birthDate: '2022-02-11', className: 'Maternal I', shift: 'manha', photo: true, consent: true, links: [{ guardian: 'aline', relationship: 'mae', isPrimary: true }, { guardian: 'renata', relationship: 'tia', validUntil: yesterday }] },
    { key: 'laura', name: 'Laura Almeida', birthDate: '2021-12-05', className: 'Maternal II', shift: 'tarde', photo: true, consent: true, links: [{ guardian: 'beatriz', relationship: 'mae', isPrimary: true }, { guardian: 'marcos', relationship: 'pai', canPickup: false }] },
    { key: 'davi', name: 'Davi Ferreira', birthDate: '2023-08-27', className: 'Berçário II', shift: 'integral', photo: true, consent: true, gateAlert: 'Não entregar ao pai — chamar a direção', notes: 'Medida protetiva em vigor (processo 0001234-56.2026)', links: [{ guardian: 'claudia', relationship: 'mae', isPrimary: true }, { guardian: 'paulo', relationship: 'pai', blocked: true, blockedReason: 'Decisão judicial — medida protetiva' }] },
    { key: 'helena', name: 'Helena Rodrigues', birthDate: '2022-10-16', className: 'Maternal I', shift: 'manha', photo: true, consent: true, links: [{ guardian: 'juliana', relationship: 'mae', isPrimary: true }, { guardian: 'zelia', relationship: 'avo' }] },
    { key: 'arthur', name: 'Arthur Lima', birthDate: '2021-06-23', className: 'Maternal II', shift: 'tarde', photo: true, consent: true, links: [{ guardian: 'simone', relationship: 'mae', isPrimary: true }, { guardian: 'antonio', relationship: 'tio' }] },
    { key: 'isabela', name: 'Isabela Martins', birthDate: '2024-04-03', className: 'Berçário II', shift: 'integral', photo: true, consent: false, notes: 'Faltando há vários dias (demonstração)', links: [{ guardian: 'vanessa', relationship: 'mae', isPrimary: true }, { guardian: 'sergio', relationship: 'pai' }] },
  ];
}

function civilAdd(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday (Mon–Fri) test for a civil date. */
function isWeekday(civil: string): boolean {
  const dow = new Date(`${civil}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** The 5 most recent weekdays ending today (today included when it is a weekday and past 07:00 local). */
export function demoDays(now: Date, tz: string): string[] {
  const today = todayCivil(tz, now);
  const days: string[] = [];
  let d = today;
  const includeToday = isWeekday(today) && zonedParts(now, tz).hour >= 7;
  if (!includeToday) d = civilAdd(d, -1);
  while (days.length < 5) {
    if (isWeekday(d)) days.push(d);
    d = civilAdd(d, -1);
  }
  return days; // newest first
}

function instant(civil: string, tz: string, minutesFromMidnight: number): string {
  const [y, m, d] = civil.split('-').map(Number);
  return zonedToUtc(tz, y, m, d, Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60, 0, 0).toISOString();
}

// ---------------------------------------------------------------------------
// Detection and cleaning
// ---------------------------------------------------------------------------

export class SeedRefused extends Error {}

/** Non-demo children, guardians/guards or events exist. */
export function hasRealData(db: Db): boolean {
  const like = `${SEED_PREFIX}%`;
  const count = (sql: string) => one<{ n: number }>(db, sql, like)?.n ?? 0;
  return (
    count(`SELECT COUNT(*) AS n FROM children WHERE id NOT LIKE ?`) > 0 ||
    count(`SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND id NOT LIKE ?`) > 0 ||
    count(`SELECT COUNT(*) AS n FROM attendance_events WHERE id NOT LIKE ?`) > 0
  );
}

/** Remove every demo row (and its photos). Returns the number of rows deleted. */
export function cleanSeed(db: Db, config: Config): number {
  const like = `${SEED_PREFIX}%`;
  return tx(db, () => {
    let n = 0;
    const del = (sql: string, ...params: unknown[]) => {
      n += run(db, sql, ...params).changes;
    };
    del(
      `DELETE FROM notifications WHERE user_id LIKE ? OR batch_id LIKE ? OR event_id LIKE ?
         OR event_id IN (SELECT id FROM attendance_events WHERE child_id LIKE ? OR guard_id LIKE ?)`,
      like,
      like,
      like,
      like,
      like
    );
    del(`DELETE FROM attendance_events WHERE id LIKE ? OR child_id LIKE ? OR guard_id LIKE ? OR guardian_id LIKE ?`, like, like, like, like);
    del(`DELETE FROM pickup_authorizations WHERE id LIKE ? OR child_id LIKE ? OR created_by LIKE ?`, like, like, like);
    del(`DELETE FROM credentials WHERE id LIKE ? OR owner_id LIKE ?`, like, like);
    del(`DELETE FROM child_guardians WHERE id LIKE ? OR child_id LIKE ? OR user_id LIKE ?`, like, like, like);
    del(`DELETE FROM push_subscriptions WHERE user_id LIKE ?`, like);
    del(`DELETE FROM sessions WHERE user_id LIKE ?`, like);
    del(`DELETE FROM auth_tokens WHERE user_id LIKE ?`, like);
    del(`DELETE FROM gate_heartbeats WHERE user_id LIKE ?`, like);
    for (const row of all<{ photo_file_id: string | null }>(db, `SELECT photo_file_id FROM users WHERE id LIKE ? AND photo_file_id IS NOT NULL`, like)) deleteFile(db, config, row.photo_file_id);
    for (const row of all<{ photo_file_id: string | null }>(db, `SELECT photo_file_id FROM children WHERE id LIKE ? AND photo_file_id IS NOT NULL`, like)) deleteFile(db, config, row.photo_file_id);
    del(`DELETE FROM children WHERE id LIKE ?`, like);
    del(`DELETE FROM users WHERE id LIKE ?`, like);
    del(`DELETE FROM audit_log WHERE actor_id LIKE ? OR entity_id LIKE ? OR action = 'seed.run'`, like, like);
    const keys = [DEMO_ADMIN.email, ...DEMO_GUARDS.map((g) => g.login), ...DEMO_GUARDIANS.map((g) => g.email).filter((e): e is string => !!e)].map((k) => `id:${k}`);
    del(`DELETE FROM login_attempts WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys);
    setSetting(db, SETTING_KEYS.demoData, null);
    bumpDirectoryVersion(db);
    return n;
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedOptions {
  force?: boolean;
  now?: Date;
}

export interface SeedSummary {
  users: number;
  children: number;
  credentials: number;
  events: number;
  notifications: number;
  photos: number;
  cleaned: number;
}

export async function runSeed(db: Db, config: Config, options: SeedOptions = {}): Promise<SeedSummary> {
  if (!options.force && hasRealData(db)) {
    throw new SeedRefused('O banco contém dados reais (crianças, responsáveis ou eventos que não são de demonstração). Use --force para semear mesmo assim.');
  }
  const now = options.now ?? new Date();
  const tz = config.tz;
  const nowIso = now.toISOString();
  const today = todayCivil(tz, now);
  const createdAt = new Date(now.getTime() - 30 * DAY_MS).toISOString(); // registered 30 days ago (streaks count)
  const cleaned = cleanSeed(db, config);
  const summary: SeedSummary = { users: 0, children: 0, credentials: 0, events: 0, notifications: 0, photos: 0, cleaned };

  // Password hashes (scrypt is async, keep them out of the transaction).
  const hashes = new Map<string, string>();
  hashes.set('admin', await hashPassword(DEMO_ADMIN.password));
  hashes.set('guard', await hashPassword(DEMO_GUARD_PASSWORD));
  for (const g of DEMO_GUARDS) hashes.set(`pin:${g.key}`, await hashPassword(g.pin));
  for (const g of DEMO_GUARDIANS) if (g.password) hashes.set(`guardian:${g.key}`, await hashPassword(g.password));

  const children = demoChildren(today);
  const userIds = new Map<string, string>();
  const childIds = new Map<string, string>();
  const credentialIds = new Map<string, string>();
  const childLinks = new Map<string, LinkSpec[]>();
  const days = demoDays(now, tz);
  const todayHasEvents = days[0] === today;

  tx(db, () => {
    // Admin, guards.
    const admin = insertUser(db, { id: seedId('user:admin'), name: DEMO_ADMIN.name, email: DEMO_ADMIN.email, role: 'admin', passwordHash: hashes.get('admin'), now: new Date(createdAt) });
    userIds.set('admin', admin.id);
    summary.users++;
    for (const g of DEMO_GUARDS) {
      const u = insertUser(db, { id: seedId(`user:${g.key}`), name: g.name, login: g.login, role: 'guard', passwordHash: hashes.get('guard'), pinHash: hashes.get(`pin:${g.key}`), now: new Date(createdAt) });
      userIds.set(g.key, u.id);
      summary.users++;
    }
    // Guardians (+ photos).
    DEMO_GUARDIANS.forEach((g, i) => {
      const u = insertUser(db, { id: seedId(`user:${g.key}`), name: g.name, email: g.email, phone: g.phone, role: 'guardian', passwordHash: hashes.get(`guardian:${g.key}`) ?? null, now: new Date(createdAt) });
      userIds.set(g.key, u.id);
      summary.users++;
      if (g.photo) {
        storePhoto(db, config, { ownerTable: 'users', ownerId: u.id, buffer: avatarPng(100 + i), actorId: admin.id, now });
        summary.photos++;
      }
    });
    // Children, links, consent, photos.
    children.forEach((c, j) => {
      const id = seedId(`child:${c.key}`);
      const primary = DEMO_GUARDIANS.find((g) => g.key === c.links.find((l) => l.isPrimary)?.guardian);
      run(
        db,
        `INSERT INTO children (id, name, birth_date, class_name, shift, gate_alert, notes, photo_file_id, active, deactivated_at,
           consent_at, consent_by_name, consent_relationship, anonymized_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?, NULL, ?, ?)`,
        id,
        c.name,
        c.birthDate,
        c.className,
        c.shift,
        c.gateAlert ?? null,
        c.notes ?? null,
        c.consent ? civilDate(createdAt, tz) : null,
        c.consent ? (primary?.name ?? null) : null,
        c.consent ? 'mae' : null,
        createdAt,
        createdAt
      );
      childIds.set(c.key, id);
      childLinks.set(c.key, c.links);
      summary.children++;
      if (c.photo) {
        storePhoto(db, config, { ownerTable: 'children', ownerId: id, buffer: avatarPng(200 + j), actorId: admin.id, now });
        summary.photos++;
      }
      for (const l of c.links) {
        run(
          db,
          `INSERT INTO child_guardians (id, child_id, user_id, relationship, can_pickup, is_primary, valid_from, valid_until, blocked, blocked_reason,
             created_by, created_at, updated_by, updated_at, removed_at, removed_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          seedId(`link:${c.key}:${l.guardian}`),
          id,
          userIds.get(l.guardian)!,
          l.relationship,
          l.canPickup === false ? 0 : 1,
          l.isPrimary ? 1 : 0,
          l.validUntil ?? null,
          l.blocked ? 1 : 0,
          l.blocked ? (l.blockedReason ?? null) : null,
          admin.id,
          createdAt,
          admin.id,
          createdAt
        );
      }
    });
    // Credentials: one per guardian and per child, fixed codes; Maria also has a revoked old card.
    const insertCredential = (key: string, ownerType: 'guardian' | 'child', ownerId: string, code: string, nfcUid: string | null, revokedAt: string | null) => {
      const id = seedId(`credential:${key}`);
      run(
        db,
        `INSERT INTO credentials (id, owner_type, owner_id, code, nfc_uid, label, active, created_by, created_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        id,
        ownerType,
        ownerId,
        code,
        revokedAt ? null : nfcUid,
        revokedAt ? 0 : 1,
        admin.id,
        revokedAt ? new Date(new Date(createdAt).getTime() - 10 * DAY_MS).toISOString() : createdAt,
        revokedAt,
        revokedAt ? admin.id : null
      );
      credentialIds.set(key, id);
      summary.credentials++;
    };
    DEMO_GUARDIANS.forEach((g, i) => insertCredential(g.key, 'guardian', userIds.get(g.key)!, guardianCode(i), g.nfcUid ?? null, null));
    children.forEach((c, j) => insertCredential(`child:${c.key}`, 'child', childIds.get(c.key)!, childCode(j), c.nfcUid ?? null, null));
    insertCredential('maria:old', 'guardian', userIds.get('maria')!, DEMO_REVOKED_CODE, null, new Date(now.getTime() - 3 * DAY_MS).toISOString());

    // One-off authorization valid today: Maria authorizes the neighbour to pick Ana up.
    run(
      db,
      `INSERT INTO pickup_authorizations (id, child_id, person_name, person_document, relationship_label, phone, valid_from, valid_until, note, created_by, created_at, revoked_at, revoked_by)
       VALUES (?, ?, 'Rosa Nascimento', '987.654.321-00', 'vizinha', '(11) 91234-0099', ?, ?, 'Vai buscar hoje porque a mãe está de plantão', ?, ?, NULL, NULL)`,
      seedId('authorization:ana:rosa'),
      childIds.get('ana')!,
      today,
      today,
      userIds.get('maria')!,
      new Date(now.getTime() - 3 * 60 * MINUTE_MS).toISOString()
    );

    // Events: 5 school days.
    const guardOf = (k: number) => DEMO_GUARDS[k % 2];
    const methodOf = (childKey: string, k: number): Method => (['nfc', 'qr', 'code', 'search'] as Method[])[h32(`method:${childKey}:${k}`) % 4];
    const batches: string[] = [];
    const insert = (key: string, spec: {
      childKey: string;
      type: EventType;
      guardianKey?: string | null;
      personName?: string | null;
      personDocument?: string | null;
      documentChecked?: boolean;
      guardKey: string;
      method: Method;
      occurredAt: string;
      note?: string | null;
      override?: boolean;
      conflict?: 'already_present' | 'already_out' | null;
      queued?: boolean;
      voided?: { at: string; by: string; reason: string } | null;
      createdAt?: string;
      batchKey?: string;
    }) => {
      const child = children.find((c) => c.key === spec.childKey)!;
      const guardian = spec.guardianKey ? DEMO_GUARDIANS.find((g) => g.key === spec.guardianKey)! : null;
      const link = guardian ? child.links.find((l) => l.guardian === guardian.key) : undefined;
      const guard = DEMO_GUARDS.find((g) => g.key === spec.guardKey)!;
      const usesCard = spec.method === 'nfc' || spec.method === 'qr' || spec.method === 'code';
      const credentialId = usesCard ? (guardian ? credentialIds.get(guardian.key)! : credentialIds.get(`child:${child.key}`)!) : null;
      const batchId = seedId(`batch:${spec.batchKey ?? key}`);
      const row = insertEventRow(db, {
        id: seedId(`event:${key}`),
        client_id: seedId(`client:${key}`),
        batch_id: batchId,
        child_id: childIds.get(child.key)!,
        child_name: child.name,
        type: spec.type,
        guardian_id: guardian ? userIds.get(guardian.key)! : null,
        guardian_name: guardian?.name ?? null,
        guardian_relationship: link?.relationship ?? null,
        person_name: guardian ? null : (spec.personName ?? null),
        person_document: guardian ? null : (spec.personDocument ?? null),
        document_checked: spec.documentChecked ? 1 : 0,
        authorization_id: null,
        authorized_by_name: null,
        guard_id: userIds.get(guard.key)!,
        guard_name: guard.name,
        method: spec.method,
        credential_id: credentialId,
        override: spec.override ? 1 : 0,
        conflict: spec.conflict ?? null,
        queued: spec.queued ? 1 : 0,
        directory_at: spec.queued ? new Date(new Date(spec.occurredAt).getTime() - 2 * 60 * MINUTE_MS).toISOString() : null,
        note: spec.note ?? null,
        occurred_at: spec.occurredAt,
        created_at: spec.createdAt ?? new Date(new Date(spec.occurredAt).getTime() + 2000).toISOString(),
      });
      if (spec.voided) run(db, 'UPDATE attendance_events SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?', spec.voided.at, userIds.get(spec.voided.by)!, spec.voided.reason, row.id);
      summary.events++;
      if (!batches.includes(batchId)) batches.push(batchId);
      return row;
    };

    // The day Gabriel entered without a registered exit (stale) and the day of the refused pickup.
    const staleK = todayHasEvents ? 1 : 0;
    days.forEach((day, k) => {
      const isToday = day === today;
      for (const c of children) {
        // Absences: Isabela always; Sofia today; Gabriel today (stale since yesterday).
        // Maria's children have not arrived yet today: the demo/e2e flow starts by confirming their ENTRADA with AAAA-2222.
        if (c.key === 'isabela') continue;
        if (isToday && (c.key === 'sofia' || c.key === 'gabriel' || c.key === 'ana' || c.key === 'pedro')) continue;
        // Siblings share the batch (one confirmation): same guardian, guard, method and time.
        const sibling = c.key === 'pedro' ? 'ana' : c.key === 'julia' ? 'lucas' : c.key;
        const pickupLinks = c.links.filter((l) => l.canPickup !== false && !l.blocked && !l.validUntil);
        const dropOff = c.links.find((l) => l.isPrimary)!;
        const pickUp = pickupLinks[(k + h32(`pick:${sibling}`)) % pickupLinks.length] ?? dropOff;
        const guard = guardOf(k + (h32(`guard:${sibling}`) % 2));
        const inMin = 7 * 60 + 20 + (h32(`in:${sibling}:${day}`) % 50);
        const outMin = 16 * 60 + 30 + (h32(`out:${sibling}:${day}`) % 75);
        let checkinAt = instant(day, tz, inMin);
        if (isToday && checkinAt > nowIso) checkinAt = new Date(now.getTime() - (40 + (h32(`late:${sibling}`) % 20)) * MINUTE_MS).toISOString();
        if (c.key === 'helena' && k === 2) {
          // A wrong tap cancelled within the undo window, then the real check-in.
          const wrong = instant(day, tz, inMin);
          insert(`in:${c.key}:${day}:wrong`, { childKey: c.key, type: 'checkin', guardianKey: dropOff.guardian, guardKey: guard.key, method: 'code', occurredAt: wrong, voided: { at: new Date(new Date(wrong).getTime() + 20_000).toISOString(), by: guard.key, reason: 'Toque errado — desfeito pela portaria' } });
          checkinAt = new Date(new Date(wrong).getTime() + 2 * MINUTE_MS).toISOString();
        }
        insert(`in:${c.key}:${day}`, { childKey: c.key, type: 'checkin', guardianKey: dropOff.guardian, guardKey: guard.key, method: methodOf(sibling, k), occurredAt: checkinAt, batchKey: `in:${sibling}:${day}` });
        if (isToday) continue; // present now
        if (c.key === 'gabriel' && k === staleK) continue; // stale: no checkout on the last school day
        if (c.key === 'laura' && k === 2) {
          // Exception: unregistered person picked Laura up (mother called), document checked.
          insert(`out:${c.key}:${day}`, {
            childKey: c.key,
            type: 'checkout',
            personName: 'Tereza Nunes',
            personDocument: '123.456.789-00',
            documentChecked: true,
            guardKey: guard.key,
            method: 'search',
            occurredAt: instant(day, tz, outMin),
            override: true,
            note: 'Mãe ligou autorizando a vizinha a buscar; documento conferido na portaria',
          });
          continue;
        }
        if (c.key === 'davi' && k === staleK) {
          // Blocked father tried to pick Davi up; refused. Mother picked him up later.
          insert(`denied:${c.key}:${day}`, { childKey: c.key, type: 'denied', guardianKey: 'paulo', guardKey: 'ana', method: 'search', occurredAt: instant(day, tz, outMin - 35), note: 'Pai bloqueado por medida protetiva — direção avisada' });
        }
        const outGuard = guardOf(k + 1);
        insert(`out:${c.key}:${day}`, { childKey: c.key, type: 'checkout', guardianKey: pickUp.guardian, guardKey: outGuard.key, method: methodOf(`${sibling}:out`, k), occurredAt: instant(day, tz, outMin), batchKey: `out:${sibling}:${day}` });
        if (c.key === 'lucas' && k === 3) {
          // A queued record that arrived after the real checkout: stored with a conflict, highlighted for the office.
          const at = instant(day, tz, outMin + 25);
          insert(`out:${c.key}:${day}:queued`, { childKey: c.key, type: 'checkout', guardianKey: 'ricardo', guardKey: 'carlos', method: 'qr', occurredAt: at, conflict: 'already_out', queued: true, createdAt: new Date(new Date(at).getTime() + 40 * MINUTE_MS).toISOString(), note: 'Registro enviado da fila do celular da portaria' });
        }
      }
    });

    // Notifications for the demo batches, already delivered (past hold window).
    const notifier = createNotifier({ db, config, now: () => now, emailEnabled: () => true, pushEnabled: () => false });
    for (const batchId of batches) {
      const first = one<{ occurred_at: string }>(db, 'SELECT occurred_at FROM attendance_events WHERE batch_id = ? ORDER BY occurred_at LIMIT 1', batchId);
      if (!first) continue;
      const dispatchAfter = new Date(new Date(first.occurred_at).getTime() + config.notifyHoldSeconds * 1000).toISOString();
      notifier.attendanceBatch(batchId, { dispatchAfter, inappOnly: civilDate(first.occurred_at, tz) === today });
      summary.notifications += run(db, `UPDATE notifications SET status = 'sent', sent_at = dispatch_after, created_at = ? WHERE batch_id = ? AND status = 'pending'`, first.occurred_at, batchId).changes;
    }
    // The revoked card and the neighbour's authorization also produced alerts.
    notifier.credentialRevoked(credentialIds.get('maria:old')!, admin.id);
    notifier.authorizationAdded(seedId('authorization:ana:rosa'), userIds.get('maria')!);
    summary.notifications += run(db, `UPDATE notifications SET status = 'sent', sent_at = dispatch_after WHERE status = 'pending' AND user_id LIKE ?`, `${SEED_PREFIX}%`).changes;

    setSetting(db, SETTING_KEYS.demoData, '1');
    bumpDirectoryVersion(db);
    audit(db, null, 'seed.run', 'settings', null, { users: summary.users, children: summary.children, events: summary.events, todayHasEvents, days }, null, now);
  });
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printCredentials(): string {
  const lines = [
    `Administração: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`,
    ...DEMO_GUARDS.map((g) => `Portaria: login ${g.login} / senha ${DEMO_GUARD_PASSWORD} / PIN ${g.pin}`),
    ...DEMO_GUARDIANS.filter((g) => g.password).map((g) => `Responsável: ${g.email} / ${g.password}`),
    '',
    'Carteirinhas (código impresso):',
    ...DEMO_GUARDIANS.map((g, i) => `  ${formatCode(guardianCode(i))}  ${g.name}${g.nfcUid ? ` (NFC ${g.nfcUid})` : ''}`),
    ...demoChildren('2000-01-01').map((c, j) => `  ${formatCode(childCode(j))}  ${c.name} (criança)${c.nfcUid ? ` (NFC ${c.nfcUid})` : ''}`),
    `  ${formatCode(DEMO_REVOKED_CODE)}  Maria Silva — carteirinha antiga, REVOGADA`,
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const clean = args.has('--clean');
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(path.join(config.dataDir, 'creche.sqlite'));
  seedSettings(db, config);
  try {
    if (clean) {
      const n = cleanSeed(db, config);
      console.log(`Dados de demonstração removidos (${n} linhas).`);
      return;
    }
    const summary = await runSeed(db, config, { force });
    console.log(
      [
        `Dados de demonstração criados em ${config.dataDir} (fuso ${config.tz}).`,
        summary.cleaned ? `Linhas de demonstração anteriores removidas: ${summary.cleaned}` : '',
        `Usuários: ${summary.users} · Crianças: ${summary.children} · Carteirinhas: ${summary.credentials} · Eventos: ${summary.events} · Notificações: ${summary.notifications} · Fotos: ${summary.photos}`,
        '',
        printCredentials(),
        '',
        'Para remover: npm run seed -- --clean',
      ]
        .filter((l) => l !== '')
        .join('\n')
    );
  } finally {
    db.close();
  }
}

const isMain = !!process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    if (err instanceof SeedRefused) {
      console.error(`\n[creche-segura] ${err.message}\n`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
