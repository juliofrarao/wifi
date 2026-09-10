/**
 * Notifier — fan-out entry points called by the routes and services.
 *
 * The real implementation (`createNotifier` in ./fanout.ts) inserts
 * `notifications` rows (inapp/push/email, status 'pending') that the
 * dispatcher (./dispatcher.ts) delivers: attendance batches after the undo
 * window (`dispatch_after = now + NOTIFY_HOLD_SECONDS`), everything else
 * immediately. `createStubNotifier` only records calls (used by unit tests
 * that do not care about rows); `withRecording` wraps the real notifier so
 * tests can assert on calls while rows are still written.
 */
import type { FastifyBaseLogger } from 'fastify';

export interface AttendanceBatchOptions {
  /** ISO instant before which nothing is sent (undo window). */
  dispatchAfter: string;
  /** Instant the office entered the sheet when the events are older than 3 h (inapp + e-mail only). */
  backfilledAt?: string | null;
  /** Automatic closings: inapp only, guardians only. */
  inappOnly?: boolean;
}

export interface Notifier {
  /** R8/R9: notify the guardians (and admins on exceptions) of every live event of the batch. */
  attendanceBatch(batchId: string, options: AttendanceBatchOptions): void;
  /** "Registro cancelado" for an event whose alerts had already been delivered. */
  eventVoided(eventId: string, actorUserId: string | null, reason: string): void;
  /** R16: the OTHER guardians of the child learn that `linkUserId` may now pick the child up. */
  guardianAdded(childId: string, linkUserId: string, actorUserId: string | null): void;
  /** R16: the other guardians learn about a one-off pickup authorization. */
  authorizationAdded(authorizationId: string, actorUserId: string | null): void;
  /** R16: the card owner (or the child's guardians) learn the card was cancelled. */
  credentialRevoked(credentialId: string, actorUserId: string | null): void;
  /** `system` notification to every active admin. */
  adminAlert(title: string, body: string, options?: { noEmail?: boolean }): void;
}

export interface NotifierCall {
  method: keyof Notifier;
  args: unknown[];
}

export interface RecordingNotifier extends Notifier {
  calls: NotifierCall[];
}

/** No-op notifier that only logs and records calls (no rows are written). */
export function createStubNotifier(log?: Pick<FastifyBaseLogger, 'info'> | Console): RecordingNotifier {
  const calls: NotifierCall[] = [];
  const record = (method: keyof Notifier, ...args: unknown[]) => {
    calls.push({ method, args });
    log?.info({ notifier: method, args }, 'notifier stub');
  };
  return {
    calls,
    attendanceBatch: (batchId, options) => record('attendanceBatch', batchId, options),
    eventVoided: (eventId, actorUserId, reason) => record('eventVoided', eventId, actorUserId, reason),
    guardianAdded: (childId, linkUserId, actorUserId) => record('guardianAdded', childId, linkUserId, actorUserId),
    authorizationAdded: (authorizationId, actorUserId) => record('authorizationAdded', authorizationId, actorUserId),
    credentialRevoked: (credentialId, actorUserId) => record('credentialRevoked', credentialId, actorUserId),
    adminAlert: (title, body, options) => record('adminAlert', title, body, options),
  };
}

/** Wrap a real notifier so that calls are recorded (tests) while rows are still written. */
export function withRecording(inner: Notifier): RecordingNotifier {
  const calls: NotifierCall[] = [];
  const wrap = <K extends keyof Notifier>(method: K) =>
    ((...args: Parameters<Notifier[K]>) => {
      calls.push({ method, args });
      return (inner[method] as (...a: unknown[]) => void)(...args);
    }) as Notifier[K];
  return {
    calls,
    attendanceBatch: wrap('attendanceBatch'),
    eventVoided: wrap('eventVoided'),
    guardianAdded: wrap('guardianAdded'),
    authorizationAdded: wrap('authorizationAdded'),
    credentialRevoked: wrap('credentialRevoked'),
    adminAlert: wrap('adminAlert'),
  };
}

export { createNotifier, type NotifierDeps } from './fanout.js';
export { dispatchOnce, startDispatcher, type DispatcherDeps, type DispatchSummary } from './dispatcher.js';
