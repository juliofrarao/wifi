/**
 * Backups: `db.backup()` snapshots into DATA_DIR/backups/creche-YYYY-MM-DD-HHmm.sqlite,
 * rotation by BACKUP_KEEP_DAYS, nightly scheduler at 02:00 (daycare TZ) and a
 * tar.gz archive (latest snapshot + uploads/) for the "download backup" button.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { civilDate } from '@creche/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { getSetting, SETTING_KEYS, setSetting } from '../db/settings.js';
import { ApiError } from '../lib/errors.js';
import { DAY_MS, zonedParts } from '../lib/time.js';

export function backupsDir(config: Config): string {
  return path.join(config.dataDir, 'backups');
}

const SNAPSHOT_RE = /^creche-(\d{4}-\d{2}-\d{2})-(\d{4})\.sqlite$/;

export function snapshotName(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `creche-${p.year}-${pad(p.month)}-${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}.sqlite`;
}

export function listSnapshots(config: Config): string[] {
  const dir = backupsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort();
}

export function latestSnapshot(config: Config): string | null {
  const list = listSnapshots(config);
  return list.length ? path.join(backupsDir(config), list[list.length - 1]) : null;
}

/** Delete snapshots older than keepDays (by file mtime). Returns the removed names. */
export function rotateBackups(config: Config, keepDays: number, now: Date): string[] {
  const dir = backupsDir(config);
  const cutoff = now.getTime() - keepDays * DAY_MS;
  const removed: string[] = [];
  for (const name of listSnapshots(config)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed.push(name);
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export interface BackupResult {
  path: string;
  lastBackupAt: string;
  removed: string[];
}

export async function runBackup(db: Db, config: Config, now: Date = new Date()): Promise<BackupResult> {
  const dir = backupsDir(config);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, snapshotName(now, config.tz));
  if (fs.existsSync(file)) file = file.replace(/\.sqlite$/, `-${now.getTime() % 100000}.sqlite`);
  const tmp = `${file}.tmp`;
  await db.backup(tmp);
  fs.renameSync(tmp, file);
  const lastBackupAt = now.toISOString();
  setSetting(db, SETTING_KEYS.lastBackupAt, lastBackupAt);
  const removed = rotateBackups(config, config.backupKeepDays, now);
  return { path: file, lastBackupAt, removed };
}

export function lastBackupAt(db: Db): string | null {
  return getSetting(db, SETTING_KEYS.lastBackupAt);
}

/**
 * Nightly scheduler: checks once a minute; runs at 02:00 in the daycare zone
 * (once per civil day). Returns a stop function.
 */
export function startBackupScheduler(db: Db, config: Config, log: FastifyBaseLogger, now: () => Date = () => new Date()): () => void {
  let lastRunDay: string | null = null;
  const last = lastBackupAt(db);
  if (last) lastRunDay = civilDate(last, config.tz);
  let running = false;
  const tick = async () => {
    if (running) return;
    const at = now();
    const p = zonedParts(at, config.tz);
    const day = civilDate(at, config.tz);
    if (p.hour !== 2 || lastRunDay === day) return;
    running = true;
    try {
      const res = await runBackup(db, config, at);
      lastRunDay = day;
      log.info({ path: res.path, removed: res.removed }, 'backup automático concluído');
    } catch (err) {
      log.error({ err }, 'falha no backup automático');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function tarAvailable(): boolean {
  try {
    return spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export interface BackupArchive {
  stream: Readable;
  filename: string;
}

/**
 * Fresh snapshot + uploads/ as a tar.gz stream (spawns `tar`). Throws
 * ApiError(INTERNAL) with a clear message when `tar` is not installed.
 */
export async function createBackupArchive(db: Db, config: Config, now: Date = new Date()): Promise<BackupArchive> {
  if (!tarAvailable()) throw new ApiError('INTERNAL', 'O utilitário "tar" não está instalado no servidor; instale-o para baixar o backup');
  const res = await runBackup(db, config, now);
  const members = [path.relative(config.dataDir, res.path)];
  const uploads = path.join(config.dataDir, 'uploads');
  if (fs.existsSync(uploads)) members.push('uploads');
  const child = spawn('tar', ['-czf', '-', '-C', config.dataDir, ...members], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => {
    child.stdout.destroy(new Error('falha ao executar tar'));
  });
  const stamp = path.basename(res.path).replace(/^creche-|\.sqlite$/g, '');
  return { stream: child.stdout, filename: `creche-backup-${stamp}.tar.gz` };
}
