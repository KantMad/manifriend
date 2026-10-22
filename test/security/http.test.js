'use strict';
// En-têtes de sécurité, fichiers servis, traversée de répertoires
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('../helpers');

let s;
before(async () => {
  s = await startServer();
  await s.user('Alice'); // crée db.json
  s.srv.flush();
});
after(() => s.stop());

// Requête brute (sans normalisation d'URL par le client)
function raw(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('en-têtes de sécurité sur la page', async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  const h = r.headers;
  assert.equal(h['x-powered-by'], undefined);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['x-frame-options'], 'DENY');
  assert.match(h['permissions-policy'], /geolocation=\(self\)/);
  const csp = h['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'aucun script en ligne ni externe');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('la page n’a aucun script en ligne ni ressource externe (compatible CSP)', async () => {
  const html = (await raw('/')).body;
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'pas de <script> en ligne');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'pas de gestionnaire onclick=… en ligne');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    if (u.startsWith('tel:') || u.startsWith('sms:')) continue;
    assert.ok(u.startsWith('/'), `ressource externe : ${u}`);
  }
});

test('les données et le code serveur ne sont jamais servis', async () => {
  for (const p of ['/data/db.json', '/db.json', '/server.js', '/lib/util.js', '/package.json', '/.env', '/node_modules/express/package.json',
    '/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/vendor/leaflet/../../../server.js', '/vendor/leaflet/..%2f..%2f..%2fserver.js',
    '/vendor/qrcode/../../package.json', '/.git/config', '/map/../server.js']) {
    const r = await raw(p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes('createServer') && !r.body.includes('"nickname"') && !r.body.includes('"dependencies"'), p);
  }
});

test('fichiers publics attendus', async () => {
  for (const [p, type] of [['/app.js', /javascript/], ['/utils.js', /javascript/], ['/style.css', /css/], ['/manifest.webmanifest', /manifest|json/],
    ['/sw.js', /javascript/], ['/vendor/leaflet/leaflet.js', /javascript/], ['/vendor/protomaps/protomaps-leaflet.js', /javascript/],
    ['/vendor/qrcode/qrcode.js', /javascript/], ['/socket.io/socket.io.js', /javascript/], ['/icons/icon-192.png', /png/]]) {
    const r = await raw(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], type, p);
  }
  assert.equal((await raw('/sw.js')).headers['cache-control'], 'no-cache');
});

test('config.json : carte OSM si aucun fichier de carte, 404 sur la carte', async () => {
  assert.deepEqual(JSON.parse((await raw('/config.json')).body), { map: 'osm' });
  assert.equal((await raw('/map/carte.pmtiles')).status, 404);
});

test('carte auto-hébergée : requêtes par plage d’octets', async () => {
  const mapFile = path.join(s.dataDir, 'carte.pmtiles');
  fs.writeFileSync(mapFile, Buffer.from('0123456789abcdef'));
  const s2 = await startServer({ mapFile });
  try {
    const get = (headers) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: s2.port, path: '/map/carte.pmtiles', headers }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      });
    });
    const part = await get({ Range: 'bytes=4-7' });
    assert.equal(part.status, 206);
    assert.equal(part.body, '4567');
    assert.equal(part.headers['accept-ranges'], 'bytes');
    const cfg = await new Promise((resolve) => http.get(`${s2.url}/config.json`, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b))); }));
    assert.deepEqual(cfg, { map: 'pmtiles', maxzoom: 15, bounds: null, partial: false }, 'fichier sans en-tête PMTiles : zoom par défaut');
  } finally {
    await s2.stop();
  }
});

test('config.json : zoom maximal lu dans l’en-tête PMTiles', async () => {
  const mapFile = path.join(s.dataDir, 'vraie.pmtiles');
  const head = Buffer.alloc(127);
  head.write('PMTiles', 0, 'latin1');
  head[7] = 3;
  head[100] = 0;
  head[101] = 14;
  fs.writeFileSync(mapFile, head);
  const s2 = await startServer({ mapFile });
  try {
    const cfg = await new Promise((resolve) => http.get(`${s2.url}/config.json`, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b))); }));
    assert.deepEqual(cfg, { map: 'pmtiles', maxzoom: 14, bounds: null, partial: false });
  } finally {
    await s2.stop();
  }
});

test('config.json : zone couverte lue dans l’en-tête PMTiles, carte partielle signalée', async () => {
  const header = (b) => {
    const head = Buffer.alloc(127);
    head.write('PMTiles', 0, 'latin1');
    head[7] = 3;
    head[101] = 15;
    b.forEach((v, i) => head.writeInt32LE(Math.round(v * 1e7), 102 + i * 4));
    return head;
  };
  const idf = path.join(s.dataDir, 'idf.pmtiles');
  const france = path.join(s.dataDir, 'france.pmtiles');
  fs.writeFileSync(idf, header([1.44, 48.12, 3.56, 49.24]));
  fs.writeFileSync(france, header([-5.3, 41.2, 9.7, 51.2]));
  const get = (srv, p) => new Promise((resolve) => http.get(`${srv.url}${p}`, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); }));
  const s2 = await startServer({ mapFile: idf });
  const s3 = await startServer({ mapFile: france });
  try {
    assert.deepEqual(JSON.parse(await get(s2, '/config.json')), { map: 'pmtiles', maxzoom: 15, bounds: [[48.12, 1.44], [49.24, 3.56]], partial: true });
    assert.equal(JSON.parse(await get(s3, '/config.json')).partial, false);
    // la politique de confidentialité nomme OpenStreetMap seulement si la carte est partielle
    assert.match(await get(s2, '/confidentialite'), /en dehors de la zone couverte/);
    assert.match(await get(s3, '/confidentialite'), /Aucun service de carte tiers/);
  } finally {
    await s2.stop();
    await s3.stop();
  }
});

test('URL inconnue : 404 sans détails internes', async () => {
  const r = await raw('/nexiste-pas');
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /Error|at |node_modules/);
  const bad = await raw('/%E0%A4%A');
  assert.ok(bad.status >= 400);
  assert.doesNotMatch(bad.body, /at |node_modules|URIError/);
});

test('healthz', async () => {
  assert.deepEqual(JSON.parse((await raw('/healthz')).body), { ok: true });
});
