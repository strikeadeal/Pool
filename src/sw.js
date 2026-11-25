// Baize service worker. Generated file list and version are injected by tools/build.mjs.
// - Precache every asset at install, fetched with a cache-busting query and SRI integrity,
//   so a stale CDN edge can never mix old and new files into one version.
// - Serve from cache first: the game works offline after the first launch.
// - Never skipWaiting on its own: the page activates a new version only at a safe moment
//   (on arriving at the menu, or at launch before the menu shows), so a game is never interrupted.
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const CACHE = 'baize-' + VERSION;
const scoped = (u) => new URL(u, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (a) => {
      const res = await fetch(new Request(scoped(a.url) + '?v=' + a.v, { cache: 'reload', integrity: a.sri }));
      if (!res.ok) throw new Error('precache failed: ' + a.url);
      await cache.put(scoped(a.url), res);
    }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('baize-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !req.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const shell = await cache.match(scoped('index.html'));
      if (shell) return shell;
      return fetch(req);
    }
    const hit = await cache.match(url.origin + url.pathname);
    return hit || fetch(req);
  })());
});
