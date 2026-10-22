/* Manif Friend — service worker : appli hors-ligne + cache des tuiles déjà vues */
const VERSION = 'mf-v14';
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js', '/vendor/qrcode/qrcode.js', '/vendor/protomaps/protomaps-leaflet.js', '/utils.js',
  '/socket.io/socket.io.js',
];
const TILES = 'mf-tiles-2';
const MAX_TILES = 1500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES && k !== MAP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Tuiles OpenStreetMap : cache d'abord (utile quand le réseau sature en manif)
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) { c.put(e.request, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    }));
    return;
  }

  // Carte vectorielle : lue par plages d'octets. On garde chaque plage déjà vue pour l'usage hors-ligne
  // (le cache n'accepte pas les réponses 206 : on les stocke en 200 sous une clé incluant la plage).
  if (url.origin === location.origin && url.pathname.startsWith('/map/')) {
    e.respondWith(rangeCached(e.request));
    return;
  }

  if (url.origin !== location.origin || url.pathname.startsWith('/socket.io/') && url.search) return;

  // Fichiers de l'appli : réseau d'abord, cache en secours
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then((r) => r || caches.match('/')))
  );
});

const MAP_CACHE = 'mf-map';
async function rangeCached(req) {
  const range = req.headers.get('range') || '';
  // Clé distincte par plage. Pas de « #… » : le cache ignore le fragment d'URL, toutes les plages
  // tomberaient sur la même entrée et la carte afficherait de mauvais morceaux.
  const key = new Request(req.url + (req.url.includes('?') ? '&' : '?') + 'mf-range=' + encodeURIComponent(range));
  const c = await caches.open(MAP_CACHE);
  const hit = await c.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    return new Response(await hit.arrayBuffer(), { status: Number(headers.get('x-mf-status')) || 200, headers });
  }
  const res = await fetch(req);
  if (res.status === 206 || res.status === 200) {
    const headers = new Headers(res.headers);
    headers.set('x-mf-status', String(res.status));
    const body = await res.clone().arrayBuffer();
    c.put(key, new Response(body, { status: 200, headers }));
  }
  return res;
}
