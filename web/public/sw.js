// Service worker de Pocket Terminal.
//
// Opening the app with no connection used to show a network error instead of
// the app itself. This keeps a copy of the page and its assets so the app
// always opens; the terminal itself still needs the server to be reachable.
//
// Nothing about a session is stored here: API answers, terminal output and the
// access cookie never reach this cache.
const CACHE = 'pocket-terminal-v1';
const SHELL = '/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

async function cacheable(request, response) {
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Live data and the terminal socket must never be answered from a cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  if (request.mode === 'navigate') {
    // The page is small and must reflect a new build straight away, so the
    // network wins whenever it answers and the copy is only a fallback.
    event.respondWith((async () => {
      try { return await cacheable(request, await fetch(request)); }
      catch { return (await caches.match(request)) || (await caches.match(SHELL)) || Response.error(); }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Built assets carry a hash in the name, so a hit is always the right file.
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      return cacheable(request, await fetch(request));
    })());
    return;
  }

  // Icons and the manifest: answer from the copy and refresh it in the back.
  event.respondWith((async () => {
    const hit = await caches.match(request);
    const live = fetch(request).then(response => cacheable(request, response)).catch(() => null);
    return hit || (await live) || Response.error();
  })());
});
