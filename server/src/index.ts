/**
 * Server entry point: config → data dirs → database → first-run seeding →
 * initial admin → Fastify app → background jobs → listen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { ensureInitialAdmin, seedSettings, StartupError } from './bootstrap.js';
import { loadConfig, loadDotEnv } from './config.js';
import { openDb } from './db/index.js';
import { startJobs } from './jobs.js';
import { createMailer } from './services/email.js';
import { createNotifier } from './services/notifications/index.js';
import { createPush } from './services/push.js';

export { startJobs } from './jobs.js';

export function dbPath(dataDir: string): string {
  return path.join(dataDir, 'creche.sqlite');
}

async function main(): Promise<void> {
  const envFile = loadDotEnv();
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });

  const db = openDb(dbPath(config.dataDir));
  seedSettings(db, config);
  const admin = await ensureInitialAdmin(db, config);

  const mailer = createMailer(config);
  const push = createPush(db, config);
  const notifier = createNotifier({ db, config, now: () => new Date(), emailEnabled: () => mailer.enabled, pushEnabled: () => push.enabled() });

  const app = buildApp({ db, config, mailer, push, notifier });
  if (envFile) app.log.info({ envFile }, 'variáveis carregadas de .env');
  if (admin.created) app.log.info({ email: config.admin.email }, 'administrador inicial criado');
  if (!mailer.enabled) app.log.warn('SMTP_HOST vazio: e-mails desativados (convites saem por WhatsApp/QR)');

  const jobs = startJobs({ db, config, mailer, push, notifier, log: app.log });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'encerrando');
    jobs.stop();
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ appUrl: config.appUrl, dataDir: config.dataDir, tz: config.tz }, 'Creche Segura no ar');
}

main().catch((err) => {
  if (err instanceof StartupError) {
    console.error(`\n[creche-segura] O servidor não pode iniciar: ${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
