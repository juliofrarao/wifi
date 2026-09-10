/**
 * SQLite connection (better-sqlite3). `openDb` applies schema.sql (idempotent)
 * and the pragmas the schema relies on. `tx` wraps a synchronous function in a
 * transaction (nested calls join the outer transaction).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

function loadSchema(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'schema.sql'), path.resolve(here, '../../src/db/schema.sql')];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error('schema.sql não encontrado');
}

let cachedSchema: string | null = null;

export function schemaSql(): string {
  if (!cachedSchema) cachedSchema = loadSchema();
  return cachedSchema;
}

export interface OpenOptions {
  /** Skip WAL (in-memory databases ignore it anyway). */
  readonly?: boolean;
}

/** Open (or create) a database and apply the schema. Use ':memory:' in tests. */
export function openDb(file: string, options: OpenOptions = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: options.readonly ?? false });
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  if (!options.readonly) db.exec(schemaSql());
  return db;
}

/** Run `fn` inside a transaction; nested `tx` calls join the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}

/** Small typed helpers to keep route code short. */
export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]): Database.RunResult {
  return db.prepare(sql).run(...params);
}

/** Build `IN (?, ?, ...)` placeholders. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
