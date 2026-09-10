/* Creche Segura — service worker (plain JavaScript, served as-is at /sw.js, scope "/").
 *
 * Caching strategy (spec §8):
 *  - index.html (navigations): network-first, cache fallback;
 *  - /assets/*: cache-first (hashed, immutable); precached from index.html on install;
 *  - /api/files/*: cache-first, capped at 600 entries (photos, signed URLs);
 *  - /api/scan/directory: network-first with cache fallback (marked with X-SW-Cache: 1);
 *  - anything else under /api: never cached.
 *
 * Messages from the page:
 *  - { type: 'precache-photos', urls: string[] }  → adds photo URLs to the files cache;
 *  - { type: 'refresh-precache' }                → re-reads index.html and precaches its assets;
 *  - { type: 'skip-waiting' }                     → activates a waiting worker.
 */

const CACHE_SHELL = 'creche-shell-v1';
const CACHE_ASSETS = 'creche-assets-v1';
const CACHE_FILES = 'creche-files-v1';
const CACHE_DIRECTORY = 'creche-directory-v1';
const FILES_MAX_ENTRIES = 600;
const KNOWN_CACHES = [CACHE_SHELL, CACHE_ASSETS, CACHE_FILES, CACHE_DIRECTORY];

const INDEX_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await precacheShell();
      } catch (err) {
        // Offline install: keep going, runtime caching will fill the gaps.
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/** Fetches index.html, caches it and precaches the hashed assets it references. */
async function precacheShell() {
  const res = await fetch(INDEX_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('index.html ' + res.status);
  const html = await res.clone().text();
  const shell = await caches.open(CACHE_SHELL);
  await shell.put(INDEX_URL, res);

  const assetUrls = new Set();
  const re = /(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) assetUrls.add(new URL(m[1], self.location.origin).href);

  const assets = await caches.open(CACHE_ASSETS);
  await Promise.all(
    [...assetUrls].map(async (url) => {
      try {
        const cached = await assets.match(url);
        if (cached) return;
        const r = await fetch(url);
        if (r.ok) await assets.put(url, r);
      } catch {
        /* ignore individual failures */
      }
    })
  );
  // Prune assets no longer referenced by the current index.html.
  const keys = await assets.keys();
  await Promise.all(keys.filter((req) => !assetUrls.has(req.url)).map((req) => assets.delete(req)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstIndex(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(CACHE_ASSETS, req));
    return;
  }
  if (url.pathname.startsWith('/api/files/')) {
    event.respondWith(cacheFirstCapped(CACHE_FILES, req, FILES_MAX_ENTRIES));
    return;
  }
  if (url.pathname === '/api/scan/directory') {
    event.respondWith(networkFirstDirectory(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    return; // never cached
  }
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest' || url.pathname === '/version.json') {
    return;
  }
  // Other same-origin static files (icons): cache-first.
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(CACHE_SHELL, req));
  }
});

async function networkFirstIndex(req) {
  const shell = await caches.open(CACHE_SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) {
      shell.put(INDEX_URL, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await shell.match(INDEX_URL);
    if (cached) return cached;
    return new Response('<!doctype html><html lang="pt-BR"><body><p>Sem conexão. Abra o app novamente quando a internet voltar.</p></body></html>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function cacheFirstCapped(cacheName, req, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone()).catch(() => {});
    trimCache(cache, maxEntries).catch(() => {});
  }
  return res;
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.length - maxEntries;
  // keys() preserves insertion order: drop the oldest entries.
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

async function networkFirstDirectory(req) {
  const cache = await caches.open(CACHE_DIRECTORY);
  try {
    const res = await fetch(req);
    if (res.status === 200) {
      cache.put('/api/scan/directory', res.clone()).catch(() => {});
    }
    return res; // 200, 304 or an API error pass through untouched
  } catch {
    const cached = await cache.match('/api/scan/directory');
    if (!cached) throw new Error('offline');
    const headers = new Headers(cached.headers);
    headers.set('X-SW-Cache', '1');
    return new Response(await cached.arrayBuffer(), { status: 200, statusText: 'OK', headers });
  }
}

// ---- Messages from the page -------------------------------------------------

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'precache-photos' && Array.isArray(data.urls)) {
    event.waitUntil(precachePhotos(data.urls));
  } else if (data.type === 'refresh-precache') {
    event.waitUntil(precacheShell().catch(() => {}));
  } else if (data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

async function precachePhotos(urls) {
  const cache = await caches.open(CACHE_FILES);
  const list = urls.filter((u) => typeof u === 'string' && u.startsWith('/api/files/')).slice(0, FILES_MAX_ENTRIES);
  const queue = list.slice();
  const workers = [];
  for (let i = 0; i < 4; i++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const url = queue.shift();
          try {
            const hit = await cache.match(url);
            if (hit) continue;
            const res = await fetch(url);
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline or bad URL: ignore */
          }
        }
      })()
    );
  }
  await Promise.all(workers);
  await trimCache(cache, FILES_MAX_ENTRIES);
}

// ---- Push -------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== 'object') {
    payload = { title: 'Creche Segura', body: event.data ? event.data.text() : '', url: '/alertas', tag: 'creche' };
  }
  const title = payload.title || 'Creche Segura';
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    data: payload,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    renotify: Boolean(payload.tag),
    requireInteraction: Boolean(payload.override),
    lang: 'pt-BR',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const target = new URL(payload.url || '/alertas', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          // Only a client that actually navigated to the alert is good enough (SW-2);
          // otherwise fall through to opening a new window with the deep link.
          if ('navigate' in client) {
            const navigated = await client.navigate(target);
            if (navigated && 'focus' in navigated) await navigated.focus();
            else if ('focus' in client) await client.focus();
            return;
          }
        } catch {
          /* navigation refused (uncontrolled client): try the next one */
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

// The browser rotated/expired the subscription: re-subscribe with the same key and let the
// open app (if any) register it; otherwise the app re-registers on its next start (SW-1).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options ? old.options.applicationServerKey : null;
      if (!key) return;
      try {
        await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        return;
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'push-resubscribed' });
    })()
  );
});
