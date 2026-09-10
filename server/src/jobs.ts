/**
 * Background jobs. `startJobs(deps)` is the hook S2 extends with the
 * notification dispatcher (every 5 s). Returns a stop function.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './context.js';
import { pruneSessions } from './auth/sessions.js';
import { pruneAttempts } from './lib/ratelimit.js';
import { HOUR_MS } from './lib/time.js';
import { startBackupScheduler } from './services/backup.js';
import { startDispatcher } from './services/notifications/dispatcher.js';

export interface JobDeps extends AppDeps {
  log: FastifyBaseLogger;
}

export interface Jobs {
  stop(): void;
}

export function startJobs(deps: JobDeps): Jobs {
  const now = deps.now ?? (() => new Date());
  const stops: (() => void)[] = [];

  stops.push(startBackupScheduler(deps.db, deps.config, deps.log, now));

  const housekeeping = setInterval(() => {
    try {
      const at = now();
      const attempts = pruneAttempts(deps.db, at);
      const sessions = pruneSessions(deps.db, deps.config, at);
      if (attempts || sessions) deps.log.debug({ attempts, sessions }, 'limpeza periódica');
    } catch (err) {
      deps.log.error({ err }, 'falha na limpeza periódica');
    }
  }, HOUR_MS);
  housekeeping.unref();
  stops.push(() => clearInterval(housekeeping));

  // Notification dispatcher (every 5 s): inapp → sent, push, e-mail with retries/quota.
  stops.push(startDispatcher({ db: deps.db, config: deps.config, mailer: deps.mailer, push: deps.push, log: deps.log, now }));

  return { stop: () => stops.forEach((s) => s()) };
}
