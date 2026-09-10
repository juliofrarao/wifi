/**
 * Runtime context shared by all route modules and services.
 *
 * `AppDeps` is what callers (index.ts, tests, S2's seed) provide; `Ctx` is
 * the enriched object routes receive (adds the resolved `now` clock, the
 * files secret and a logger).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Mailer } from './services/email.js';
import type { Notifier } from './services/notifications/index.js';
import type { PushService } from './services/push.js';

export interface AppDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  push: PushService;
  notifier: Notifier;
  /** Clock; defaults to `() => new Date()`. Tests inject a controllable one. */
  now?: () => Date;
}

export interface Ctx extends AppDeps {
  now: () => Date;
  /** settings.files_secret (seeded on first run; never changes afterwards). */
  filesSecret: string;
  log: FastifyBaseLogger;
  /** Web bundle version read from WEB_DIST/version.json (or 'dev'). */
  appVersion: string;
}
