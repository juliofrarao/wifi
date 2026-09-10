/**
 * Offline queue (IndexedDB "queue" store) + single drain worker.
 *
 * Triggers: app open, visibilitychange, online, after any successful request
 * (creche:request-ok), after enqueue, after login (retryNeedsLogin).
 * Every drain attempt POSTs /scan/heartbeat.
 */
import { QUEUE_SCHEMA_VERSION, type CreateEventsBody, type EventType } from '@creche/shared';
import { isApiError, REQUEST_OK_EVENT, getToken } from '../api/client';
import { createEvents, heartbeat } from '../api/endpoints';
import { STORAGE_KEYS, readJson } from '../lib/storage';
import { GATE_STORES, getGateDb, idbDelete, idbGetAll, idbPut } from '../lib/idb';
import { createStore, useStore } from '../lib/store';
import {
  applyOutcome,
  backoffMs,
  bodyForSend,
  createQueueItem,
  isQueueLate,
  markSending,
  nextToSend,
  notApplied,
  pruneQueue,
  queueCounts,
  QUEUE_TIMEOUT_MS,
  type QueueCounts,
  type SendOutcome,
  type StoredQueueItem,
} from './queueLogic';
import { useNow } from '../lib/useNow';

export const queueStore = createStore<StoredQueueItem[]>([]);
/** Events: 'sent' (detail: StoredQueueItem), 'changed'. */
export const queueEvents = new EventTarget();

let loadPromise: Promise<void> | null = null;
let draining = false;
let kickAgain = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastHeartbeatAt = 0;
/** Batches removed while the worker may still hold a reference (undo race). */
const removed = new Set<string>();
let directoryGeneratedAtProvider: () => string | null = () => null;

/** The directory module registers how to read generatedAt (avoids an import cycle). */
export function setDirectoryGeneratedAtProvider(fn: () => string | null): void {
  directoryGeneratedAtProvider = fn;
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await getGateDb();
        const items = await idbGetAll<StoredQueueItem>(db, GATE_STORES.queue);
        const now = new Date().toISOString();
        // Items stuck in "sending" from a killed tab go back to pending.
        const restored = items.map((i) => (i.status === 'sending' ? { ...i, status: 'pending' as const, updatedAt: now } : i));
        const pruned = pruneQueue(restored, now);
        for (const gone of restored.filter((i) => !pruned.includes(i))) await idbDelete(db, GATE_STORES.queue, gone.batchId);
        for (const changed of restored.filter((i, idx) => i !== items[idx] && pruned.includes(i))) await idbPut(db, GATE_STORES.queue, changed);
        queueStore.set(pruned);
      } catch {
        queueStore.set([]);
      }
    })();
  }
  return loadPromise;
}

async function persist(item: StoredQueueItem): Promise<void> {
  if (removed.has(item.batchId)) return;
  queueStore.set((items) => {
    const idx = items.findIndex((i) => i.batchId === item.batchId);
    if (idx === -1) return [...items, item];
    const copy = items.slice();
    copy[idx] = item;
    return copy;
  });
  queueEvents.dispatchEvent(new CustomEvent('changed'));
  try {
    const db = await getGateDb();
    await idbPut(db, GATE_STORES.queue, item);
  } catch {
    /* memory-only fallback */
  }
}

async function remove(batchId: string): Promise<void> {
  removed.add(batchId);
  queueStore.set((items) => items.filter((i) => i.batchId !== batchId));
  queueEvents.dispatchEvent(new CustomEvent('changed'));
  try {
    const db = await getGateDb();
    await idbDelete(db, GATE_STORES.queue, batchId);
  } catch {
    /* ignore */
  }
}

/** Loads the queue from IndexedDB (idempotent). */
export function loadQueue(): Promise<void> {
  return ensureLoaded();
}

export function getQueueItem(batchId: string): StoredQueueItem | null {
  return queueStore.get().find((i) => i.batchId === batchId) ?? null;
}

/** Adds a confirmation to the queue and starts draining. */
export async function enqueue(
  body: CreateEventsBody,
  summary: { type: EventType; childNames: string[]; personName: string },
  batchId: string = crypto.randomUUID()
): Promise<StoredQueueItem> {
  await ensureLoaded();
  const item = createQueueItem(body, summary, batchId, new Date().toISOString(), QUEUE_SCHEMA_VERSION);
  removed.delete(batchId);
  await persist(item);
  kickQueue('enqueue', true);
  return item;
}

export async function getQueueCounts(): Promise<QueueCounts> {
  await ensureLoaded();
  return queueCounts(queueStore.get());
}

/** needs_login → pending (after a fresh login). */
export async function retryNeedsLogin(): Promise<void> {
  await ensureLoaded();
  const now = new Date().toISOString();
  for (const item of queueStore.get()) {
    if (item.status === 'needs_login') await persist({ ...item, status: 'pending', updatedAt: now, lastAttemptAt: null });
  }
  kickQueue('login', true);
}

/** Removes an item (dismiss "Não aplicados" or undo of an unsent batch). */
export async function removeQueueItem(batchId: string): Promise<void> {
  await ensureLoaded();
  await remove(batchId);
}

/** Dismisses a rejected result inside a sent batch (or the whole rejected batch). */
export async function dismissNotApplied(batchId: string, childId: string | null): Promise<void> {
  await ensureLoaded();
  const item = getQueueItem(batchId);
  if (!item) return;
  if (item.status === 'rejected' || !item.result || childId === null) {
    await remove(batchId);
    return;
  }
  const results = item.result.results.filter((r) => !(r.status === 'rejected' && r.childId === childId));
  await persist({ ...item, result: { ...item.result, results }, updatedAt: new Date().toISOString() });
}

/** Wakes the worker. `immediate` bypasses the current backoff (online, visibility, manual). */
export function kickQueue(_reason: string, immediate = false): void {
  if (immediate && retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (immediate) {
    const now = new Date().toISOString();
    const items = queueStore.get().map((i) => (i.status === 'pending' && i.lastAttemptAt ? { ...i, lastAttemptAt: null, updatedAt: now } : i));
    queueStore.set(items);
  }
  if (draining) {
    kickAgain = true;
    return;
  }
  void drain();
}

async function sendHeartbeat(force: boolean): Promise<void> {
  if (!getToken()) return;
  // Only gate sessions report: guards always, admins only while using the gate screens
  // (a guardian session would get a 403; an admin on the panel is not a gate).
  const role = readJson<{ role?: string }>(STORAGE_KEYS.user)?.role;
  if (role === 'guardian') return;
  if (role === 'admin' && !window.location.pathname.startsWith('/portaria')) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastHeartbeatAt < 30_000) return;
  lastHeartbeatAt = nowMs;
  const counts = queueCounts(queueStore.get());
  try {
    await heartbeat({ queuedCount: counts.waiting, oldestQueuedAt: counts.oldestWaitingAt, appVersion: __APP_VERSION__ });
  } catch {
    /* heartbeat is best effort */
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await ensureLoaded();
    void sendHeartbeat(false);
    for (;;) {
      kickAgain = false;
      if (!getToken()) break;
      const item = nextToSend(queueStore.get());
      if (!item) break;
      // Respect backoff.
      if (item.lastAttemptAt) {
        const earliest = Date.parse(item.lastAttemptAt) + backoffMs(item.attempts);
        const wait = earliest - Date.now();
        if (wait > 0) {
          scheduleRetry(wait);
          break;
        }
      }
      const now = new Date().toISOString();
      void sendHeartbeat(true);
      const sending = markSending(item, now);
      await persist(sending);
      if (removed.has(item.batchId)) continue; // undone before it left the device
      const outcome = await send(sending, now);
      if (removed.has(item.batchId)) continue;
      const t = applyOutcome(sending, outcome, new Date().toISOString());
      await persist(t.item);
      if (t.item.status === 'sent') queueEvents.dispatchEvent(new CustomEvent('sent', { detail: t.item }));
      if (t.retry) {
        scheduleRetry(t.retryInMs);
        break;
      }
    }
  } finally {
    draining = false;
    if (kickAgain) {
      kickAgain = false;
      void drain();
    }
  }
}

function scheduleRetry(ms: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drain();
  }, Math.max(250, ms));
}

async function send(item: StoredQueueItem, now: string): Promise<SendOutcome> {
  try {
    const result = await createEvents(bodyForSend(item, now, directoryGeneratedAtProvider()), { timeoutMs: QUEUE_TIMEOUT_MS });
    return { kind: 'ok', result };
  } catch (err) {
    if (isApiError(err)) {
      if (err.code === 'TIMEOUT') return { kind: 'timeout' };
      if (err.code === 'NETWORK') return { kind: 'network', message: err.message };
      return { kind: 'http', status: err.status, code: err.code, message: err.message };
    }
    return { kind: 'network', message: err instanceof Error ? err.message : 'Erro' };
  }
}

// ---- Global triggers (registered once) ------------------------------------------

let triggersInstalled = false;
export function installQueueTriggers(): void {
  if (triggersInstalled || typeof window === 'undefined') return;
  triggersInstalled = true;
  window.addEventListener('online', () => kickQueue('online', true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kickQueue('visibility', true);
  });
  window.addEventListener(REQUEST_OK_EVENT, () => kickQueue('request-ok', true));
  void ensureLoaded().then(() => kickQueue('open', true));
}

// ---- React binding ----------------------------------------------------------------

export function useQueue() {
  const items = useStore(queueStore);
  const counts = queueCounts(items);
  const now = useNow(15_000, counts.waiting > 0);
  return {
    items,
    counts,
    notApplied: notApplied(items),
    late: isQueueLate(counts, now),
  };
}
