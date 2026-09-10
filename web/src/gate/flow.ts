/**
 * Gate flow state (in memory): the lookup waiting for confirmation, the
 * "Próximo" read that arrived during a confirmation, the success screen, and
 * anti-repeat memory (2 s duplicate reads, 15 s "Já registrado").
 */
import type { EventType, Method, ScanLookupResult } from '@creche/shared';
import { createStore, useStore } from '../lib/store';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage';

export type GateMode = 'nfc' | 'qr' | 'code' | 'search';

export interface PendingPerson {
  name: string;
  relationshipLabel: string;
  authorizationId: string | null;
  authorizedBy: string | null;
}

export interface PendingLookup {
  id: string;
  result: ScanLookupResult;
  method: Method;
  credentialId: string | null;
  source: 'directory' | 'live';
  readAt: string;
  code: string | null;
  uid: string | null;
  /** Dedupe key (credential id or owner id). */
  key: string;
  /** Pre-select this action (manual "Registrar saída"). */
  forcedAction?: 'checkin' | 'checkout';
  /** Person chosen from a child card (authorized person / "outra pessoa"). */
  person?: PendingPerson;
}

export interface SuccessInfo {
  batchId: string;
  type: EventType;
  childNames: string[];
  personName: string;
  at: string;
  undoUntil: string;
}

export interface FlowState {
  pending: PendingLookup | null;
  next: PendingLookup | null;
  success: SuccessInfo | null;
  /** Ask the guard to confirm who is on duty (app returned after > 6 h hidden). */
  switchSuggested: boolean;
}

export const flowStore = createStore<FlowState>({ pending: null, next: null, success: null, switchSuggested: false });

export function setPending(p: PendingLookup | null): void {
  flowStore.set((s) => ({ ...s, pending: p }));
}
export function setNext(p: PendingLookup | null): void {
  flowStore.set((s) => ({ ...s, next: p }));
}
/** Promotes "next" to pending; returns it (or null). */
export function takeNext(): PendingLookup | null {
  const { next } = flowStore.get();
  flowStore.set((s) => ({ ...s, pending: next, next: null }));
  return next;
}
export function setSuccess(s: SuccessInfo | null): void {
  flowStore.set((st) => ({ ...st, success: s }));
}
export function setSwitchSuggested(v: boolean): void {
  flowStore.set((s) => ({ ...s, switchSuggested: v }));
}
export function useFlow(): FlowState {
  return useStore(flowStore);
}

// ---- Anti-repeat memory --------------------------------------------------------------

const DUP_WINDOW_MS = 2000;
const RECENT_SUCCESS_MS = 15_000;
let lastRead: { key: string; at: number } | null = null;
const recentSuccess = new Map<string, { at: number; time: string }>();

/** Same card read again within 2 s → ignore. */
export function isDuplicateRead(key: string, nowMs = Date.now()): boolean {
  if (lastRead && lastRead.key === key && nowMs - lastRead.at < DUP_WINDOW_MS) return true;
  lastRead = { key, at: nowMs };
  return false;
}

/** Returns the registration time when the same card succeeded in the last 15 s. */
export function recentSuccessTime(key: string, nowMs = Date.now()): string | null {
  const hit = recentSuccess.get(key);
  if (!hit) return null;
  if (nowMs - hit.at > RECENT_SUCCESS_MS) {
    recentSuccess.delete(key);
    return null;
  }
  return hit.time;
}

export function rememberSuccess(keys: string[], time: string, nowMs = Date.now()): void {
  for (const k of keys) recentSuccess.set(k, { at: nowMs, time });
}

export function forgetSuccess(): void {
  recentSuccess.clear();
  lastRead = null;
}

// ---- Last mode ---------------------------------------------------------------------

export function getSavedMode(): GateMode | null {
  const m = readString(STORAGE_KEYS.gateMode);
  return m === 'nfc' || m === 'qr' || m === 'code' || m === 'search' ? m : null;
}
export function saveMode(mode: GateMode): void {
  writeString(STORAGE_KEYS.gateMode, mode);
}
