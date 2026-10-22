'use strict';
// Vérification d'un site Manif Friend en ligne (après une mise en ligne ou une mise à jour).
//   node scripts/smoke-test.js https://manif-friend.fr [--insecure] [--key CLE_ORGANISATEUR] [--expect-map]
// N'enregistre rien de durable : crée un pseudo et un groupe de test puis les efface (droit à l'oubli).
const https = require('https');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/$/, '');
const insecure = args.includes('--insecure');
const keyIdx = args.indexOf('--key');
const orgKey = keyIdx >= 0 ? args[keyIdx + 1] : '';
const expectMap = args.includes('--expect-map');
if (!base) {
  console.log('Usage : node scripts/smoke-test.js https://site [--insecure] [--key CLE] [--expect-map]');
  process.exit(2);
}
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const agent = new https.Agent({ rejectUnauthorized: !insecure });

let failed = 0;
const ok = (msg) => console.log('✓ ' + msg);
const ko = (msg) => {
  failed++;
  console.log('✗ ' + msg);
  if (process.env.GITHUB_ACTIONS) console.log('::error::' + msg);
};
const check = (cond, msg) => (cond ? ok(msg) : ko(msg));

function request(path, { headers = {}, redirect = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(u, { agent: u.protocol === 'https:' ? agent : undefined, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('délai dépassé')));
    req.end();
  });
}

function client(token) {
  const s = io(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false, rejectUnauthorized: !insecure });
  const call = (ev, d) => new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('pas de réponse à ' + ev)), 10000);
    s.emit(ev, d, (x) => (clearTimeout(t), r(x)));
  });
  const wait = (ev, pred = () => true, ms = 10000) => new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('attente de ' + ev)), ms);
    const h = (x) => { if (pred(x)) { clearTimeout(t); s.off(ev, h); r(x); } };
    s.on(ev, h);
  });
  return new Promise((resolve, reject) => {
    s.once('init', (init) => resolve({ s, call, wait, init }));
    s.once('connect_error', reject);
  });
}

(async () => {
  console.log(`Vérification de ${base}\n`);
  // --- HTTP ---
  const home = await request('/');
  check(home.status === 200 && home.body.toString().includes('Manif Friend'), 'la page d’accueil répond');
  const h = home.headers;
  check(/default-src 'self'/.test(h['content-security-policy'] || ''), 'politique de sécurité du contenu (CSP)');
  check(h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY', 'en-têtes anti-détournement');
  if (base.startsWith('https')) check(/max-age=\d+/.test(h['strict-transport-security'] || ''), 'HTTPS imposé (HSTS)');
  check(!h['x-powered-by'] && !h.server, 'aucune signature du serveur');
  const health = await request('/healthz');
  check(health.status === 200 && JSON.parse(health.body).ok === true, 'healthz');
  for (const p of ['/app.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/vendor/leaflet/leaflet.js', '/vendor/protomaps/protomaps-leaflet.js', '/socket.io/socket.io.js'])
    check((await request(p)).status === 200, `fichier ${p}`);
  for (const p of ['/confidentialite', '/mentions-legales']) {
    const r = await request(p);
    check(r.status === 200 && !/\{\{|<script/.test(r.body), `page ${p}`);
  }
  for (const p of ['/data/db.json', '/server.js', '/.env', '/package.json']) check((await request(p)).status === 404, `${p} n’est pas exposé`);
  const cfg = JSON.parse((await request('/config.json')).body);
  if (expectMap) {
    check(cfg.map === 'pmtiles', `carte auto-hébergée active (zoom max ${cfg.maxzoom})`);
    const part = await request('/map/carte.pmtiles', { headers: { Range: 'bytes=0-6' } });
    check(part.status === 206 && part.body.toString('latin1') === 'PMTiles', 'carte lue par plages d’octets');
  } else ok(`carte : ${cfg.map === 'pmtiles' ? 'auto-hébergée' : 'tuiles OpenStreetMap (carte pas encore téléchargée)'}`);
  if (base.startsWith('https')) {
    try {
      const plain = await new Promise((resolve, reject) => require('http').get(base.replace('https:', 'http:') + '/', (r) => resolve(r)).on('error', reject));
      check([301, 302, 307, 308].includes(plain.statusCode) && (plain.headers.location || '').startsWith('https://'), 'http:// redirige vers https://');
    } catch (e) {
      ko('http:// injoignable : ' + e.message);
    }
  }

  // --- Temps réel ---
  const tok = () => 'verif-' + crypto.randomBytes(16).toString('hex');
  const visitor = await client(tok());
  ok('connexion temps réel (WebSocket)');
  check((await visitor.call('report', { type: 'info', lat: 48.8674, lng: 2.3631 })).auth === true, 'un visiteur sans compte ne peut pas agir');
  visitor.s.close();
  // comptes de test (pseudo + mot de passe), supprimés à la fin
  const suffix = crypto.randomBytes(2).toString('hex');
  async function account(name) {
    const g = await client(tok());
    const r = await g.call('account:register', { name, password: crypto.randomBytes(12).toString('hex') });
    g.s.close();
    if (!r.ok) throw new Error('création de compte : ' + r.error);
    return client(r.token);
  }
  const a = await account('Vérif A ' + suffix);
  const b = await account('Vérif B ' + suffix);
  check(a.init.me.account && b.init.me.account, 'création de comptes et sessions');
  const gName = 'Vérification ' + crypto.randomBytes(3).toString('hex');
  const groupsP = a.wait('groups', (gs) => gs.some((x) => x.name === gName));
  const g = await a.call('group:create', { name: gName });
  check(g.ok, 'création de groupe');
  const groups = await groupsP;
  const code = groups.find((x) => x.id === g.id).code;
  check((await b.call('group:join', { code })).ok, 'demande d’adhésion');
  check((await a.call('group:approve', { groupId: g.id, userId: b.init.me.id })).ok, 'acceptation par l’admin');
  b.s.emit('pos', { lat: 48.8674, lng: 2.3631, mode: 'named' });
  const pos = await a.wait('group:pos', (m) => m.groupId === g.id && m.list.some((p) => p.nickname === 'Vérif B ' + suffix), 15000).catch(() => null);
  check(!!pos, 'position d’un membre reçue par le groupe');
  const rep = await a.call('report', { type: 'info', lat: 48.8674, lng: 2.3631, note: 'Vérification automatique' });
  check(rep.ok, 'signalement');
  await b.call('vote', { id: rep.id, v: -1 });
  if (orgKey) {
    const o = await client(tok());
    check((await o.call('organizer', { key: orgKey })).ok, 'clé organisateur·ice acceptée');
    check((await o.call('report:delete', { id: rep.id })).ok, 'suppression du signalement de test');
    o.s.close();
  }
  // Nettoyage : droit à l'oubli (supprime comptes, groupe et position)
  await a.call('group:delete', { groupId: g.id });
  check((await a.call('forget')).ok && (await b.call('forget')).ok, 'effacement des données de test');
  a.s.close();
  b.s.close();
  console.log(failed ? `\n${failed} problème(s).` : '\nTout fonctionne.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  ko('erreur : ' + e.message);
  process.exit(1);
});
