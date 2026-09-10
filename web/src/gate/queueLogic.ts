/**
 * Offline queue — pure state transitions (unit tested).
 * pending → sending → sent | rejected | needs_login
 */
import type { CreateEventsBody, CreateEventsResult, EventType, QueueItem } from '@creche/shared';

export const QUEUE_TIMEOUT_MS = 5000;
export const BACKOFF_MIN_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;
/** Queue chip turns red when the oldest pending item is older than this. */
export const QUEUE_LATE_MS = 10 * 60 * 1000;
/** Sent items without rejections are dropped after this. */
export const SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Items retried or older than this are sent with `queued: true` (device time, conflicts recorded). */
export const QUEUED_AFTER_MS = 60_000;

export interface StoredQueueItem extends QueueItem {
  /** Last state change. */
  updatedAt: string;
  /** Last attempt (for backoff). */
  lastAttemptAt: string | null;
}

export type SendOutcome =
  | { kind: 'ok'; result: CreateEventsResult }
  | { kind: 'http'; status: number; code?: string; message?: string }
  | { kind: 'network'; message?: string }
  | { kind: 'timeout' };

export function createQueueItem(
  body: CreateEventsBody,
  summary: { type: EventType; childNames: string[]; personName: string },
  batchId: string,
  now: string,
  schemaVersion: number
): StoredQueueItem {
  return {
    batchId,
    schemaVersion,
    body,
    summary,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    lastError: null,
    result: null,
    updatedAt: now,
    lastAttemptAt: null,
  };
}

/** Exponential backoff 2 s → 60 s. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (n - 1));
}

export function markSending(item: StoredQueueItem, now: string): StoredQueueItem {
  return { ...item, status: 'sending', updatedAt: now, lastAttemptAt: now };
}

/** Body actually sent: `queued` reflects whether this is a delayed retry. */
export function bodyForSend(item: StoredQueueItem, now: string, directoryGeneratedAt: string | null): CreateEventsBody {
  const age = Date.parse(now) - Date.parse(item.createdAt);
  const queued = item.attempts > 0 || age > QUEUED_AFTER_MS;
  return { ...item.body, queued, directoryGeneratedAt: item.body.directoryGeneratedAt ?? directoryGeneratedAt };
}

export interface Transition {
  item: StoredQueueItem;
  retry: boolean;
  retryInMs: number;
}

/** Applies a send outcome to an item in `sending` state. */
export function applyOutcome(item: StoredQueueItem, outcome: SendOutcome, now: string): Transition {
  switch (outcome.kind) {
    case 'ok':
      return { item: { ...item, status: 'sent', result: outcome.result, lastError: null, updatedAt: now }, retry: false, retryInMs: 0 };
    case 'http': {
      if (outcome.status === 401) {
        return {
          item: { ...item, status: 'needs_login', lastError: outcome.message ?? 'Sessão expirada', updatedAt: now },
          retry: false,
          retryInMs: 0,
        };
      }
      if (outcome.status >= 400 && outcome.status < 500) {
        const label = outcome.code ? `${outcome.code}: ${outcome.message ?? ''}`.trim() : (outcome.message ?? `Erro ${outcome.status}`);
        return { item: { ...item, status: 'rejected', lastError: label, updatedAt: now }, retry: false, retryInMs: 0 };
      }
      const attempts = item.attempts + 1;
      return {
        item: { ...item, status: 'pending', attempts, lastError: outcome.message ?? `Erro ${outcome.status}`, updatedAt: now },
        retry: true,
        retryInMs: backoffMs(attempts),
      };
    }
    case 'timeout':
    case 'network': {
      const attempts = item.attempts + 1;
      const message = outcome.kind === 'timeout' ? 'Sem resposta do servidor' : (outcome.message ?? 'Sem conexão');
      return { item: { ...item, status: 'pending', attempts, lastError: message, updatedAt: now }, retry: true, retryInMs: backoffMs(attempts) };
    }
  }
}

/** Oldest pending item (FIFO by createdAt). */
export function nextToSend(items: StoredQueueItem[]): StoredQueueItem | null {
  const pending = items.filter((i) => i.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return pending[0] ?? null;
}

export interface QueueCounts {
  pending: number;
  sending: number;
  needsLogin: number;
  rejected: number;
  sent: number;
  /** pending + sending + needs_login */
  waiting: number;
  oldestWaitingAt: string | null;
}

export function queueCounts(items: StoredQueueItem[]): QueueCounts {
  const counts: QueueCounts = { pending: 0, sending: 0, needsLogin: 0, rejected: 0, sent: 0, waiting: 0, oldestWaitingAt: null };
  for (const i of items) {
    if (i.status === 'pending') counts.pending++;
    else if (i.status === 'sending') counts.sending++;
    else if (i.status === 'needs_login') counts.needsLogin++;
    else if (i.status === 'rejected') counts.rejected++;
    else if (i.status === 'sent') counts.sent++;
    if (i.status === 'pending' || i.status === 'sending' || i.status === 'needs_login') {
      if (!counts.oldestWaitingAt || i.createdAt < counts.oldestWaitingAt) counts.oldestWaitingAt = i.createdAt;
    }
  }
  counts.waiting = counts.pending + counts.sending + counts.needsLogin;
  return counts;
}

export interface NotAppliedEntry {
  batchId: string;
  childId: string | null;
  childName: string;
  type: EventType;
  personName: string;
  code: string | null;
  message: string;
  at: string;
}

/** "Não aplicados": rejected results of sent batches + batches rejected as a whole. */
export function notApplied(items: StoredQueueItem[]): NotAppliedEntry[] {
  const out: NotAppliedEntry[] = [];
  for (const item of items) {
    if (item.status === 'rejected') {
      out.push({
        batchId: item.batchId,
        childId: null,
        childName: item.summary.childNames.join(', '),
        type: item.summary.type,
        personName: item.summary.personName,
        code: item.lastError?.split(':')[0] ?? null,
        message: item.lastError ?? 'Recusado pelo servidor',
        at: item.updatedAt,
      });
      continue;
    }
    if (item.status === 'sent' && item.result) {
      for (const r of item.result.results) {
        if (r.status !== 'rejected') continue;
        const idx = item.body.events.findIndex((e) => e.clientId === r.clientId);
        out.push({
          batchId: item.batchId,
          childId: r.childId,
          childName: item.summary.childNames[idx] ?? 'Criança',
          type: item.summary.type,
          personName: item.summary.personName,
          code: r.error?.code ?? null,
          message: r.error?.message ?? 'Não aplicado',
          at: item.updatedAt,
        });
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Drops sent items without rejections after the retention period. */
export function pruneQueue(items: StoredQueueItem[], now: string): StoredQueueItem[] {
  const limit = Date.parse(now) - SENT_RETENTION_MS;
  return items.filter((i) => {
    if (i.status !== 'sent') return true;
    const hasRejected = i.result?.results.some((r) => r.status === 'rejected') ?? false;
    if (hasRejected) return true;
    return Date.parse(i.updatedAt) > limit;
  });
}

/** Whether the queue chip should be red. */
export function isQueueLate(counts: QueueCounts, nowMs: number): boolean {
  return counts.oldestWaitingAt !== null && nowMs - Date.parse(counts.oldestWaitingAt) > QUEUE_LATE_MS;
}
