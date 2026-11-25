// Service worker: keeps the app itself (pages, scripts, runtimes) on the
// device so a Join page can still open and run solo if the Hub disappears.
// Models and photos are cached separately by shared/filecache.ts.

declare const __BUILD__: string;
// Minimal service-worker typings (the project compiles against the DOM lib).
interface ExtEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEv extends ExtEvent {
  request: Request;
  respondWith(r: Promise<Response>): void;
}
const sw = self as unknown as {
  addEventListener(t: 'install' | 'activate', f: (e: ExtEvent) => void): void;
  addEventListener(t: 'fetch', f: (e: FetchEv) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const SHELL = `recompute-shell-${__BUILD__}`;
const RUNTIME = 'recompute-runtime-v1';
const PRECACHE = ['/join', '/static/style.css', '/static/icon.svg', '/manifest.webmanifest', '/dist/node.js', '/dist/compute.js'];

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('recompute-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  // Never intercept the API, sockets, big models or photos (filecache owns those) or ranged requests.
  if (p.startsWith('/api/') || p === '/ws' || p.startsWith('/models/') || p.startsWith('/data/') || req.headers.has('range')) return;
  if (p.startsWith('/vendor/')) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === 'navigate' || p.startsWith('/dist/') || p.startsWith('/static/') || p === '/manifest.webmanifest') {
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? '/join' : null));
  }
});

async function cacheFirst(req: Request) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req: Request, fallback: string | null) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await caches.match(req, { ignoreSearch: true })) ?? (fallback ? await caches.match(fallback) : undefined);
    if (hit) return hit;
    throw err;
  }
}
