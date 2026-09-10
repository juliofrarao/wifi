/**
 * Offline directory store: ScanDirectory in IndexedDB (kv "directory") with
 * ETag / If-None-Match, refreshed on open, visibilitychange, after each sync
 * and when AppConfig.directoryVersion changes. Posts photo URLs to the
 * service worker for precaching.
 */
import type { ScanDirectory } from '@creche/shared';
import { AUTH_EXPIRED_EVENT, getToken, isApiError } from '../api/client';
import { getDirectoryRaw } from '../api/endpoints';
import { GATE_STORES, getGateDb, idbDelete, idbGet, idbPut } from '../lib/idb';
import { createStore, useStore } from '../lib/store';
import { STORAGE_KEYS, readJson, writeJson } from '../lib/storage';
import { queueEvents, setDirectoryGeneratedAtProvider } from './queue';
import { pruneLocalEventsAfterRefresh } from './status';

export interface DirectoryState {
  directory: ScanDirectory | null;
  etag: string | null;
  /** Last successful contact with the server (200 or 304). */
  fetchedAt: string | null;
  loading: boolean;
  error: string | null;
}

interface StoredDirectory {
  directory: ScanDirectory;
  etag: string | null;
  fetchedAt: string | null;
}

const KV_KEY = 'directory';
const MIN_INTERVAL_MS = 5000;

export const directoryStore = createStore<DirectoryState>({ directory: null, etag: null, fetchedAt: null, loading: false, error: null });

setDirectoryGeneratedAtProvider(() => directoryStore.get().directory?.generatedAt ?? null);

let loadPromise: Promise<void> | null = null;
let inflight: Promise<RefreshOutcome> | null = null;
let lastRefreshAt = 0;

export function loadDirectory(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await getGateDb();
        const stored = await idbGet<StoredDirectory>(db, GATE_STORES.kv, KV_KEY);
        if (stored?.directory) {
          directoryStore.set((s) => ({ ...s, directory: stored.directory, etag: stored.etag, fetchedAt: stored.fetchedAt }));
        }
      } catch {
        /* no local copy */
      }
    })();
  }
  return loadPromise;
}

export type RefreshOutcome = 'updated' | 'unchanged' | 'failed' | 'skipped';

/**
 * GET /scan/directory with If-None-Match. `force` ignores the 5 s throttle
 * (used for version changes, manual refresh and post-sync refreshes).
 */
export async function refreshDirectory(reason: string, force = false): Promise<RefreshOutcome> {
  if (!getToken()) return 'skipped';
  if (inflight) return inflight;
  if (!force && Date.now() - lastRefreshAt < MIN_INTERVAL_MS) return 'skipped';
  inflight = (async (): Promise<RefreshOutcome> => {
    await loadDirectory();
    directoryStore.set((s) => ({ ...s, loading: true }));
    try {
      const current = directoryStore.get();
      const res = await getDirectoryRaw(current.etag);
      const now = new Date().toISOString();
      lastRefreshAt = Date.now();
      if (res.status === 304) {
        directoryStore.set((s) => ({ ...s, fetchedAt: now, loading: false, error: null }));
        await save({ directory: current.directory!, etag: current.etag, fetchedAt: now }).catch(() => undefined);
        return 'unchanged';
      }
      const fromSwCache = res.headers.get('X-SW-Cache') === '1';
      const directory = (await res.json()) as ScanDirectory;
      if (fromSwCache && current.directory) {
        // Offline: the service worker served its cached copy; our IndexedDB copy is at least as fresh.
        directoryStore.set((s) => ({ ...s, loading: false, error: 'Sem conexão' }));
        return 'failed';
      }
      const etag = res.headers.get('ETag') ?? (fromSwCache ? current.etag : null);
      const fetchedAt = fromSwCache ? current.fetchedAt : now;
      directoryStore.set({ directory, etag, fetchedAt, loading: false, error: null });
      await save({ directory, etag, fetchedAt }).catch(() => undefined);
      await pruneLocalEventsAfterRefresh(directory.generatedAt).catch(() => undefined);
      precachePhotos(directory);
      return 'updated';
    } catch (err) {
      const message = isApiError(err) ? err.message : 'Falha ao atualizar o diretório';
      directoryStore.set((s) => ({ ...s, loading: false, error: message }));
      return 'failed';
    } finally {
      inflight = null;
    }
  })();
  void reason;
  return inflight;
}

async function save(stored: StoredDirectory): Promise<void> {
  const db = await getGateDb();
  await idbPut(db, GATE_STORES.kv, stored, KV_KEY);
}

/** Clears the local directory (401 / logout). The queue is untouched. */
export async function clearDirectory(): Promise<void> {
  directoryStore.set({ directory: null, etag: null, fetchedAt: null, loading: false, error: null });
  loadPromise = Promise.resolve();
  try {
    const db = await getGateDb();
    await idbDelete(db, GATE_STORES.kv, KV_KEY);
  } catch {
    /* ignore */
  }
}

function precachePhotos(directory: ScanDirectory): void {
  try {
    const urls = new Set<string>();
    for (const g of directory.guardians) if (g.photoUrl) urls.add(g.photoUrl);
    for (const c of directory.children) {
      if (c.photoUrl) urls.add(c.photoUrl);
      for (const g of c.guardians) if (g.photoUrl) urls.add(g.photoUrl);
    }
    navigator.serviceWorker?.controller?.postMessage({ type: 'precache-photos', urls: [...urls] });
  } catch {
    /* no SW */
  }
}

/** Age of the directory data in ms (null when there is none). */
export function directoryAgeMs(state: DirectoryState, nowMs = Date.now()): number | null {
  const at = state.fetchedAt ?? state.directory?.generatedAt ?? null;
  return at ? nowMs - Date.parse(at) : null;
}

export function useDirectory(): DirectoryState {
  return useStore(directoryStore);
}

// ---- Recent people (per device) ---------------------------------------------------

export interface RecentPerson {
  ownerType: 'guardian' | 'child';
  ownerId: string;
  name: string;
  at: string;
}

export function getRecentPeople(): RecentPerson[] {
  return readJson<RecentPerson[]>(STORAGE_KEYS.gateRecent) ?? [];
}

export function rememberRecentPerson(p: Omit<RecentPerson, 'at'>): void {
  const list = getRecentPeople().filter((r) => !(r.ownerType === p.ownerType && r.ownerId === p.ownerId));
  list.unshift({ ...p, at: new Date().toISOString() });
  writeJson(STORAGE_KEYS.gateRecent, list.slice(0, 8));
}

// ---- Wiring (once) --------------------------------------------------------------------

let wired = false;
export function installDirectoryWiring(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener(AUTH_EXPIRED_EVENT, () => void clearDirectory());
  // After each successful sync the directory is refreshed (debounced by the 5 s throttle + force).
  let timer: ReturnType<typeof setTimeout> | null = null;
  queueEvents.addEventListener('sent', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshDirectory('sync', true);
    }, 800);
  });
}

// Clearing on 401 must work even when the gate UI is not mounted.
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_EXPIRED_EVENT, () => void clearDirectory());
}
