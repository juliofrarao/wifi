/**
 * Minimal promise wrapper over IndexedDB (no dependencies).
 *
 * Gate database "creche-gate":
 *  - kv          : out-of-line keys (directory, meta)
 *  - queue       : keyPath batchId (offline queue items)
 *  - localEvents : keyPath clientId (status overlay events)
 */
export interface StoreSpec {
  name: string;
  keyPath?: string;
}

export function openDatabase(name: string, version: number, stores: StoreSpec[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponível'));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s.name)) {
          db.createObjectStore(s.name, s.keyPath ? { keyPath: s.keyPath } : undefined);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Falha ao abrir o banco local'));
    req.onblocked = () => reject(new Error('Banco local bloqueado por outra aba'));
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Erro no banco local'));
  });
}

export function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return promisify(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return promisify(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export function idbPut(db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  const tx = db.transaction(store, 'readwrite');
  return promisify(key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key));
}

export function idbPutMany(db: IDBDatabase, store: string, values: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Erro no banco local'));
    tx.onabort = () => reject(tx.error ?? new Error('Transação abortada'));
  });
}

export function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return promisify(db.transaction(store, 'readwrite').objectStore(store).delete(key)).then(() => undefined);
}

export function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return promisify(db.transaction(store, 'readwrite').objectStore(store).clear()).then(() => undefined);
}

// ---- Gate database singleton ------------------------------------------------

export const GATE_DB_NAME = 'creche-gate';
export const GATE_DB_VERSION = 1;
export const GATE_STORES = {
  kv: 'kv',
  queue: 'queue',
  localEvents: 'localEvents',
} as const;

let gateDbPromise: Promise<IDBDatabase> | null = null;

export function getGateDb(): Promise<IDBDatabase> {
  if (!gateDbPromise) {
    gateDbPromise = openDatabase(GATE_DB_NAME, GATE_DB_VERSION, [
      { name: GATE_STORES.kv },
      { name: GATE_STORES.queue, keyPath: 'batchId' },
      { name: GATE_STORES.localEvents, keyPath: 'clientId' },
    ]).catch((err) => {
      gateDbPromise = null;
      throw err;
    });
  }
  return gateDbPromise;
}
