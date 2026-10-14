// Hearth service worker: offline app shell + cross-origin isolation headers.
// Models are cached separately by WebLLM (Cache API) and llama.cpp/wllama (OPFS).
const VERSION = "mv7u74o6";
const SHELL = `hearth-shell-${VERSION}`;
const PRECACHE = ["./","app.css","app.js","chunks/browser-GOA3WECF.js","chunks/chunk-6DHFEWGX.js","chunks/chunk-RV4NYAIL.js","chunks/lib-HKB75LDS.js","chunks/pdf-34MXPLAO.js","chunks/wllama-IH4PTX3A.js","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/icon.svg","index.html","manifest.webmanifest","pdf.worker.min.mjs","webllm-worker.js","wllama.wasm"];
const COI = new URL(self.location).searchParams.get('coi') === '1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hearth-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

function withHeaders(res) {
  if (!COI || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (req.mode === 'navigate') {
      // network first for the page, so updates arrive; fall back to cache offline
      try {
        const res = await fetch(req);
        if (res.ok) cache.put('./', res.clone());
        return withHeaders(res);
      } catch {
        return withHeaders((await cache.match('./')) || (await cache.match('index.html')) || Response.error());
      }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return withHeaders(hit);
    try {
      const res = await fetch(req);
      if (res.ok && !url.pathname.endsWith('sw.js')) cache.put(req, res.clone());
      return withHeaders(res);
    } catch {
      return Response.error();
    }
  })());
});
