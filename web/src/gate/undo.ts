/**
 * Undo of the last batch: kept in localStorage { batchId, eventIds, undoUntil }.
 * "Desfazer" removes the batch from the queue when it was not sent yet, or
 * POSTs /attendance/events/:id/void for each created event otherwise.
 */
import type { EventType } from '@creche/shared';
import { describeError } from '../api/client';
import { voidEvent } from '../api/endpoints';
import { createStore, useStore } from '../lib/store';
import { STORAGE_KEYS, readJson, writeJson } from '../lib/storage';
import { refreshDirectory } from './directory';
import { getQueueItem, queueEvents, queueStore, removeQueueItem } from './queue';
import type { StoredQueueItem } from './queueLogic';
import { voidLocalBatch } from './status';

export const UNDO_REASON = 'Desfeito pela portaria';

export interface UndoState {
  batchId: string;
  type: EventType;
  childNames: string[];
  /** ISO instant until which "Desfazer" is offered. */
  undoUntil: string;
  /** Server ids of created events (filled when the batch is sent). */
  eventIds: string[];
  createdAt: string;
}

export const undoStore = createStore<UndoState | null>(readJson<UndoState>(STORAGE_KEYS.gateUndo));
export const undoEvents = new EventTarget(); // 'undone'

function persist(state: UndoState | null): void {
  undoStore.set(state);
  writeJson(STORAGE_KEYS.gateUndo, state);
}

export function setUndo(state: UndoState): void {
  persist(state);
}

export function clearUndo(): void {
  persist(null);
}

/** Whether the undo window is still open. */
export function undoActive(state: UndoState | null, nowMs = Date.now()): boolean {
  return Boolean(state) && Date.parse(state!.undoUntil) > nowMs;
}

function onBatchSent(item: StoredQueueItem): void {
  const state = undoStore.get();
  if (!state || state.batchId !== item.batchId || !item.result) return;
  const eventIds = item.result.results.filter((r) => r.status === 'created' && r.event).map((r) => r.event!.id);
  persist({ ...state, eventIds, undoUntil: item.result.undoUntil ?? state.undoUntil });
}

let wired = false;
export function installUndoWiring(): void {
  if (wired) return;
  wired = true;
  queueEvents.addEventListener('sent', (ev) => onBatchSent((ev as CustomEvent<StoredQueueItem>).detail));
}

function waitWhileSending(batchId: string, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => getQueueItem(batchId)?.status !== 'sending';
    if (check()) {
      resolve();
      return;
    }
    const unsub = queueStore.subscribe(() => {
      if (check()) {
        unsub();
        clearTimeout(timer);
        resolve();
      }
    });
    const timer = setTimeout(() => {
      unsub();
      resolve();
    }, maxMs);
  });
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

/** Performs the undo of the current batch. */
export async function performUndo(): Promise<UndoResult> {
  const state = undoStore.get();
  if (!state) return { ok: false, message: 'Nada para desfazer.' };
  await waitWhileSending(state.batchId, 6000);
  const item = getQueueItem(state.batchId);
  try {
    if (item && (item.status === 'pending' || item.status === 'needs_login' || item.status === 'rejected')) {
      await removeQueueItem(state.batchId);
      await voidLocalBatch(state.batchId);
      clearUndo();
      undoEvents.dispatchEvent(new CustomEvent('undone'));
      return { ok: true, message: 'Registro desfeito (não chegou a ser enviado).' };
    }
    if (item?.status === 'sending') {
      return { ok: false, message: 'Registro ainda está sendo enviado. Tente de novo em instantes.' };
    }
    const ids = state.eventIds.length ? state.eventIds : (item?.result?.results.filter((r) => r.status === 'created' && r.event).map((r) => r.event!.id) ?? []);
    if (ids.length === 0) {
      await voidLocalBatch(state.batchId);
      clearUndo();
      undoEvents.dispatchEvent(new CustomEvent('undone'));
      return { ok: true, message: 'Nenhum registro foi criado.' };
    }
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await voidEvent(id, UNDO_REASON);
      } catch (err) {
        failures.push(describeError(err));
      }
    }
    if (failures.length === ids.length) return { ok: false, message: `Não foi possível desfazer: ${failures[0]}` };
    await voidLocalBatch(state.batchId);
    clearUndo();
    undoEvents.dispatchEvent(new CustomEvent('undone'));
    void refreshDirectory('undo', true);
    return failures.length ? { ok: true, message: 'Registro desfeito parcialmente. Confira o histórico.' } : { ok: true, message: 'Registro desfeito.' };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

export function useUndo(): UndoState | null {
  return useStore(undoStore);
}
