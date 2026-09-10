/**
 * Local status overlay store: events this device recorded, persisted in
 * IndexedDB "localEvents", merged over directory statuses (statusLogic.ts).
 */
import type { ChildStatus, CreateEventsResult, ScanDirectory } from '@creche/shared';
import { GATE_STORES, getGateDb, idbDelete, idbGetAll, idbPutMany } from '../lib/idb';
import { createStore, useStore } from '../lib/store';
import { applyOverlay, countPresence, pruneLocalEvents, type LocalEvent, type PresenceCounts } from './statusLogic';
import { queueEvents, queueStore } from './queue';
import type { StoredQueueItem } from './queueLogic';

export const localEventsStore = createStore<LocalEvent[]>([]);

let loadPromise: Promise<void> | null = null;

export function loadLocalEvents(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await getGateDb();
        localEventsStore.set(await idbGetAll<LocalEvent>(db, GATE_STORES.localEvents));
      } catch {
        localEventsStore.set([]);
      }
    })();
  }
  return loadPromise;
}

async function persistMany(events: LocalEvent[]): Promise<void> {
  localEventsStore.set((prev) => {
    const map = new Map(prev.map((e) => [e.clientId, e]));
    for (const e of events) map.set(e.clientId, e);
    return [...map.values()];
  });
  try {
    const db = await getGateDb();
    await idbPutMany(db, GATE_STORES.localEvents, events);
  } catch {
    /* memory only */
  }
}

async function deleteMany(clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const gone = new Set(clientIds);
  localEventsStore.set((prev) => prev.filter((e) => !gone.has(e.clientId)));
  try {
    const db = await getGateDb();
    for (const id of clientIds) await idbDelete(db, GATE_STORES.localEvents, id);
  } catch {
    /* ignore */
  }
}

export async function addLocalEvents(events: LocalEvent[]): Promise<void> {
  await loadLocalEvents();
  await persistMany(events);
}

/** After the server accepted a batch: attach server ids / times, drop rejected ones. */
export async function markBatchSent(batchId: string, result: CreateEventsResult, sentAt: string): Promise<void> {
  await loadLocalEvents();
  const mine = localEventsStore.get().filter((e) => e.batchId === batchId);
  if (mine.length === 0) return;
  const updated: LocalEvent[] = [];
  for (const e of mine) {
    const r = result.results.find((x) => x.clientId === e.clientId);
    if (!r) continue;
    if (r.status === 'rejected') {
      updated.push({ ...e, sentAt, voided: true });
    } else {
      updated.push({
        ...e,
        sentAt,
        serverEventId: r.event?.id ?? e.serverEventId,
        occurredAt: r.event?.occurredAt ?? e.occurredAt,
      });
    }
  }
  await persistMany(updated);
}

/** Marks every event of a batch as voided (undo / removed from the queue). */
export async function voidLocalBatch(batchId: string): Promise<void> {
  await loadLocalEvents();
  const mine = localEventsStore.get().filter((e) => e.batchId === batchId && !e.voided);
  await persistMany(mine.map((e) => ({ ...e, voided: true })));
}

/** Marks one event as voided by its server id (Hoje / Histórico "Cancelar registro"). */
export async function voidLocalEventByServerId(serverEventId: string): Promise<void> {
  await loadLocalEvents();
  const mine = localEventsStore.get().filter((e) => e.serverEventId === serverEventId && !e.voided);
  await persistMany(mine.map((e) => ({ ...e, voided: true })));
}

/** After a directory refresh: drop events the directory already reflects. */
export async function pruneLocalEventsAfterRefresh(generatedAt: string | null): Promise<void> {
  await loadLocalEvents();
  const unsent = new Set(queueStore.get().filter((i) => i.status !== 'sent' && i.status !== 'rejected').map((i) => i.batchId));
  const before = localEventsStore.get();
  const keep = pruneLocalEvents(before, generatedAt, unsent);
  const gone = before.filter((e) => !keep.includes(e)).map((e) => e.clientId);
  await deleteMany(gone);
}

const EMPTY_STATUS: ChildStatus = { present: false, since: null, lastEvent: null, stale: false };

/** Builds a status resolver over a directory + local events. */
export function makeStatusResolver(
  dir: ScanDirectory | null,
  events: LocalEvent[],
  today: string,
  timeZone: string
): (childId: string, base?: ChildStatus, baseAt?: string | null) => ChildStatus {
  const byId = new Map((dir?.children ?? []).map((c) => [c.id, c.status]));
  return (childId, base, baseAt) => {
    const b = base ?? byId.get(childId) ?? EMPTY_STATUS;
    const at = baseAt !== undefined ? baseAt : (dir?.generatedAt ?? null);
    return applyOverlay(b, at, events, childId, today, timeZone);
  };
}

export function presenceCounts(dir: ScanDirectory | null, statusOf: (childId: string) => ChildStatus): PresenceCounts {
  return countPresence(dir?.children ?? [], statusOf);
}

export function useLocalEvents(): LocalEvent[] {
  return useStore(localEventsStore);
}

// ---- Wiring to the queue (once) --------------------------------------------------

let wired = false;
export function installStatusWiring(): void {
  if (wired) return;
  wired = true;
  queueEvents.addEventListener('sent', (ev) => {
    const item = (ev as CustomEvent<StoredQueueItem>).detail;
    if (item?.result) void markBatchSent(item.batchId, item.result, item.updatedAt);
  });
}
