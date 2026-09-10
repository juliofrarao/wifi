/**
 * `npm run purge` — LGPD retention (spec §11):
 *  - anonymize children inactive for more than RETENTION_MONTHS;
 *  - delete login_attempts older than 24 h;
 *  - null person_document older than 12 months (attendance_events, pickup_authorizations).
 * Safe to run while the server is up (short transactions).
 */
import path from 'node:path';
import { seedSettings } from './bootstrap.js';
import { type Config, loadConfig, loadDotEnv } from './config.js';
import { type Db, all, openDb, run } from './db/index.js';
import type { ChildRow } from './db/rows.js';
import { pruneAttempts } from './lib/ratelimit.js';
import { minusMonthsIso } from './lib/time.js';
import { anonymizeChild } from './services/anonymize.js';

export interface PurgeSummary {
  childrenAnonymized: number;
  loginAttemptsDeleted: number;
  eventDocumentsCleared: number;
  authorizationDocumentsCleared: number;
}

export function runPurge(db: Db, config: Config, now: Date = new Date()): PurgeSummary {
  const retentionCutoff = minusMonthsIso(now, config.retentionMonths);
  const documentCutoff = minusMonthsIso(now, 12);
  const candidates = all<ChildRow>(
    db,
    'SELECT * FROM children WHERE active = 0 AND anonymized_at IS NULL AND deactivated_at IS NOT NULL AND deactivated_at < ?',
    retentionCutoff
  );
  let childrenAnonymized = 0;
  for (const child of candidates) {
    anonymizeChild(db, config, child, { actor: null, reason: `Retenção de ${config.retentionMonths} meses (npm run purge)`, now });
    childrenAnonymized++;
  }
  const loginAttemptsDeleted = pruneAttempts(db, now);
  const eventDocumentsCleared = run(db, 'UPDATE attendance_events SET person_document = NULL WHERE person_document IS NOT NULL AND created_at < ?', documentCutoff).changes;
  const authorizationDocumentsCleared = run(db, 'UPDATE pickup_authorizations SET person_document = NULL WHERE person_document IS NOT NULL AND created_at < ?', documentCutoff).changes;
  return { childrenAnonymized, loginAttemptsDeleted, eventDocumentsCleared, authorizationDocumentsCleared };
}

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(path.join(config.dataDir, 'creche.sqlite'));
  seedSettings(db, config);
  const summary = runPurge(db, config);
  db.close();
  console.log(
    [
      `Crianças anonimizadas (inativas há mais de ${config.retentionMonths} meses): ${summary.childrenAnonymized}`,
      `Tentativas de login apagadas (> 24 h): ${summary.loginAttemptsDeleted}`,
      `Documentos apagados em eventos (> 12 meses): ${summary.eventDocumentsCleared}`,
      `Documentos apagados em autorizações (> 12 meses): ${summary.authorizationDocumentsCleared}`,
    ].join('\n')
  );
}

const isMain = !!process.argv[1] && /purge\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
