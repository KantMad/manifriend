'use strict';
// Manif Friend — serveur temps réel (Express + Socket.IO)
// Principes : positions uniquement en mémoire, expiration automatique,
// aucun journal de géolocalisation, identité = jeton aléatoire côté client.

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const U = require('./lib/util');
const { createOrganizers } = require('./lib/organizers');
const { legalConfig, renderLegal, loadTemplates } = require('./lib/legal');
const { createFileStore, createPgStore } = require('./lib/store');
const A = require('./lib/accounts');
const { createRoutePlanner } = require('./lib/route');
const { createGeocoder } = require('./lib/geocode');
const { version: VERSION } = require('./package.json');

const POSITION_TTL = 5 * 60 * 1000; // une position disparaît après 5 min sans mise à jour
const GROUP_TICK = 4000;
const DENSITY_TICK = 10000;
const CLEANUP_TICK = 15000;
// Actions réservées aux comptes (regarder la carte et les signalements reste libre)
const NEED_ACCOUNT = new Set(['profile', 'pos', 'report', 'vote', 'group:create', 'group:join', 'group:approve', 'group:reject', 'group:kick',
  'group:promote', 'group:meet', 'group:code', 'group:delete', 'group:leave', 'account:password', 'account:logout']);

const VOTE_EXTEND = 10 * 60 * 1000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "connect-src 'self' ws: wss: https://tile.openstreetmap.org", // le service worker télécharge les tuiles
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function createServer(opts = {}) {
  const o = {
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    adminKey: process.env.ADMIN_KEY || '',
    secret: process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex'),
    inactiveDays: Number(process.env.INACTIVE_DAYS) || 30,
    // Comptes et sessions inutilisés depuis N jours : supprimés (une session ouverte le reste jusque-là)
    accountDays: Number(process.env.ACCOUNT_INACTIVE_DAYS) || 365,
    // coût scrypt (N) ; PASSWORD_COST ne sert qu'aux tests de charge (jamais en dessous de 1024)
    passwordCost: Math.max(1024, Number(process.env.PASSWORD_COST) || 16384),
    registerPerIpHour: Number(process.env.REGISTER_PER_IP_HOUR) || 2000, // créations de compte par IP et par heure
    trustProxy: process.env.TRUST_PROXY === '1',
    databaseUrl: process.env.DATABASE_URL || '',
    store: null, // stockage injecté (tests)
    mapFile: process.env.MAP_FILE || path.join(__dirname, 'map', 'carte.pmtiles'),
    // Import automatique des manifs (Demosphere, Mobilizon, Paris-luttes) : intervalle en ms, 0 = désactivé
    importEvery: process.env.IMPORT_EVERY_MIN === '0' ? 0 : (Number(process.env.IMPORT_EVERY_MIN) || 120) * 60000,
    legal: legalConfig(),
    // Manifs importées jugées sûres publiées sans validation (AUTO_PUBLISH=0 pour tout valider à la main)
    autoPublish: process.env.AUTO_PUBLISH !== '0',
    importer: null,
    routePlanner: null, // fonction async (étapes, { near }) -> { points } ; par défaut lib/route
 // fonction async (contexte) -> rapport ; par défaut lib/importers
    timers: true,
    saveDelay: 500,
    // Signalements et votes diffusés par lots : un seul message par intervalle, quel que soit leur nombre
    reportBatchMs: 1000,
    now: Date.now,
    log: console,
    ...opts,
  };
  const now = o.now;
  // Empreinte factice : une connexion à un pseudo inexistant prend autant de temps qu'une vraie
  const DUMMY_HASH = `scrypt$${o.passwordCost}$${'A'.repeat(22)}$${'A'.repeat(43)}`;
  // ---------- Persistance (groupes, comptes, manifs ; jamais les positions ni les signalements) ----------
  // Fichier data/db.json par défaut ; Postgres si DATABASE_URL est défini (chargé au démarrage)
  const store = o.store || (o.databaseUrl ? createPgStore(o.databaseUrl, { log: o.log }) : createFileStore(o.dataDir));
  let db = { users: {}, groups: {}, events: {} };
  function adopt(data) {
    db = data && typeof data === 'object' ? data : { users: {}, groups: {}, events: {} };
    for (const k of ['users', 'groups', 'events', 'sessions']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
    delete db.routes; // ancien format : les parcours sont maintenant rattachés aux manifs
  }
  try {
    adopt(store.loadSync ? store.loadSync() : null);
  } catch (e) {
    o.log.error('Lecture base impossible, démarrage à vide :', e.message);
    adopt(null);
  }

  let saveTimer = null;
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return store.save(JSON.stringify(db));
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, o.saveDelay);
  }

  // ---------- État éphémère (mémoire seulement) ----------
  const positions = new Map(); // userId -> { lat, lng, acc, mode, ts }
  const reports = new Map(); // id -> report
  const sockets = new Map(); // userId -> Set<socket>
  const rate = U.createRateLimiter(now);
  const organizers = createOrganizers({ dataDir: o.dataDir, mainKey: o.adminKey });
  const routePlanner = o.routePlanner || createRoutePlanner({ geocode: createGeocoder() });
  let lastDensity = [];

  // ---------- Utilitaires ----------
  const uid = (n = 9) => crypto.randomBytes(n).toString('base64url');
  const today = () => U.dayOf(now());
  const getGroup = (id) => U.own(db.groups, id);
  const member = (g, id) => U.own(g.members, id);
  const pendingOf = (g, id) => U.own(g.pending, id);
  const hasNick = (userId) => !!(U.own(db.users, userId) && db.users[userId].nickname);
  const nick = (userId) => (hasNick(userId) ? db.users[userId].nickname : 'Sans pseudo');
  const isAdmin = (g, userId) => !!(g && member(g, userId) && g.members[userId].role === 'admin');
  // Adresse IP utilisée seulement en mémoire pour limiter les abus, jamais enregistrée.
  // X-Forwarded-For n'est lu que derrière un reverse proxy de confiance (TRUST_PROXY=1).
  const clientIp = (socket) =>
    String((o.trustProxy && socket.handshake.headers['x-forwarded-for']) || socket.handshake.address).split(',')[0].trim();
  const parisToday = () => U.parisDate(now());
  const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);
  const publicEvent = (e) => ({
    id: e.id, title: e.title, date: e.date, time: e.time, place: e.place, city: e.city, note: e.note, url: e.url,
    lat: e.lat, lng: e.lng, approx: e.approx, points: e.points, source: e.source,
  });
  // Seules les manifs validées par un·e organisateur·ice sont publiques
  const publicEvents = () => Object.values(db.events).filter((e) => e.status === 'published').sort(byDate).map(publicEvent);
  const adminEvents = () => Object.values(db.events).sort(byDate).map((e) => ({ ...publicEvent(e), status: e.status, sourceId: e.sourceId, edited: !!e.edited, by: e.by || null, auto: !!e.autoPublished, why: e.why || '' }));
  let importReport = null;
  function eventsChanged(publicToo = true) {
    save();
    if (publicToo) io.emit('events', publicEvents());
    io.to('organizers').emit('events:admin', { events: adminEvents(), report: importReport });
  }

  // ---------- Index : retrouver instantanément les groupes d'une personne et un groupe par son code ----------
  // (sans eux, chaque connexion parcourait tous les groupes : coûteux avec des milliers de groupes)
  const userGroups = new Map(); // userId -> Set(groupId), membre ou en attente
  const byCode = new Map(); // code d'invitation -> groupId
  function link(userId, gid) {
    if (!userGroups.has(userId)) userGroups.set(userId, new Set());
    userGroups.get(userId).add(gid);
  }
  function unlink(userId, gid) {
    const set = userGroups.get(userId);
    if (!set) return;
    set.delete(gid);
    if (!set.size) userGroups.delete(userId);
  }
  function indexGroup(g) {
    byCode.set(g.code, g.id);
    for (const id of [...Object.keys(g.members), ...Object.keys(g.pending)]) link(id, g.id);
  }
  function dropGroup(g) {
    if (byCode.get(g.code) === g.id) byCode.delete(g.code);
    for (const id of [...Object.keys(g.members), ...Object.keys(g.pending)]) unlink(id, g.id);
    delete db.groups[g.id];
  }
  const groupsOf = (userId) => [...(userGroups.get(userId) || [])].map(getGroup).filter(Boolean);
  // Pseudo (clé d'unicité) -> compte
  const byName = new Map();
  function reindex() {
    userGroups.clear();
    byCode.clear();
    byName.clear();
    Object.values(db.groups).forEach(indexGroup);
    for (const [id, u] of Object.entries(db.users)) if (u.pass) byName.set(A.nameKey(u.nickname), id);
  }
  reindex();

  // Supprime une personne : groupes quittés, compte, pseudo et sessions effacés
  function deleteUser(id) {
    positions.delete(id);
    for (const g of groupsOf(id)) {
      if (pendingOf(g, id)) {
        delete g.pending[id];
        unlink(id, g.id);
      }
      if (member(g, id) && removeMember(g, id)) pushGroupToAll(g);
    }
    const u = U.own(db.users, id);
    if (u && u.pass && byName.get(A.nameKey(u.nickname)) === id) byName.delete(A.nameKey(u.nickname));
    delete db.users[id];
    endSessions(id);
    save();
  }
  function endSessions(id, except) {
    for (const [k, sess] of Object.entries(db.sessions)) if (sess.id === id && k !== except) delete db.sessions[k];
    for (const sock of sockets.get(id) || []) if (sock.data.session !== except) sock.disconnect(true);
  }

  function touch(userId) {
    const d = today();
    let changed = false;
    if (hasNick(userId) && db.users[userId].seen !== d) {
      db.users[userId].seen = d;
      changed = true;
    }
    for (const g of groupsOf(userId))
      if (member(g, userId) && g.active !== d) {
        g.active = d;
        changed = true;
      }
    if (changed) save();
  }
  function emitToUser(userId, ev, data) {
    const set = sockets.get(userId);
    if (set) for (const s of set) s.emit(ev, data);
  }

  // ---------- Vues des groupes ----------
  function groupViewFor(g, userId) {
    const m = member(g, userId);
    if (!m) {
      if (pendingOf(g, userId)) return { id: g.id, name: g.name, description: g.description, status: 'pending' };
      return null;
    }
    const view = {
      id: g.id,
      name: g.name,
      description: g.description,
      status: 'member',
      role: m.role,
      members: Object.entries(g.members).map(([id, mm]) => ({ id, nickname: nick(id), role: mm.role, me: id === userId })),
    };
    if (g.meet) view.meet = g.meet;
    if (m.role === 'admin') {
      view.code = g.code;
      view.pending = Object.entries(g.pending).map(([id, p]) => ({ id, nickname: nick(id), at: p.at }));
    }
    return view;
  }
  const groupsFor = (userId) => groupsOf(userId).map((g) => groupViewFor(g, userId)).filter(Boolean);
  const pushGroups = (userId) => emitToUser(userId, 'groups', groupsFor(userId));
  function pushGroupToAll(g) {
    new Set([...Object.keys(g.members), ...Object.keys(g.pending)]).forEach(pushGroups);
  }
  function syncRooms(userId) {
    const set = sockets.get(userId);
    if (!set) return;
    for (const s of set) {
      for (const room of s.rooms) if (room.startsWith('g:')) s.leave(room);
      for (const g of groupsOf(userId)) if (member(g, userId)) s.join('g:' + g.id);
    }
  }
  // Retire un membre ; supprime le groupe s'il est vide, sinon garantit un·e admin
  function removeMember(g, userId) {
    delete g.members[userId];
    unlink(userId, g.id);
    const rest = Object.keys(g.members);
    if (rest.length === 0) {
      dropGroup(g);
      return false;
    }
    if (!rest.some((id) => g.members[id].role === 'admin')) g.members[rest[0]].role = 'admin';
    return true;
  }

  // ---------- Diffusion groupée des signalements ----------
  // Avec des milliers de téléphones, envoyer chaque signalement et chaque vote séparément à tout le monde
  // saturait le réseau du serveur. On regroupe : au plus un message « reports » par intervalle.
  const outbox = { add: new Map(), update: new Map(), remove: new Set() };
  let flushTimer = null;
  function queueReport(kind, r) {
    if (kind === 'remove') {
      outbox.add.delete(r);
      outbox.update.delete(r);
      outbox.remove.add(r);
    } else if (kind === 'add' || outbox.add.has(r.id)) outbox.add.set(r.id, r);
    else outbox.update.set(r.id, r);
    if (!flushTimer) flushTimer = setTimeout(flushReports, o.reportBatchMs);
  }
  function flushReports() {
    flushTimer = null;
    const msg = { add: [...outbox.add.values()].map(publicReport), update: [...outbox.update.values()].map(publicReport), remove: [...outbox.remove] };
    outbox.add.clear();
    outbox.update.clear();
    outbox.remove.clear();
    if (msg.add.length || msg.update.length || msg.remove.length) io.emit('reports', msg);
  }

  const publicReport = (r) => ({
    id: r.id, type: r.type, lat: r.lat, lng: r.lng, note: r.note, heading: r.heading,
    createdAt: r.createdAt, expiresAt: r.expiresAt, up: r.up, down: r.down,
  });

  // ---------- Serveur HTTP ----------
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });
  const vendor = (p) => express.static(path.join(__dirname, 'node_modules', p), { maxAge: '7d', index: false });
  app.use('/vendor/qrcode', vendor('qrcode-generator'));
  app.use('/vendor/leaflet', vendor('leaflet/dist'));
  app.use('/vendor/protomaps', vendor('protomaps-leaflet/dist'));
  // Carte vectorielle de Paris auto-hébergée (requêtes par plages d'octets)
  app.get('/map/carte.pmtiles', (req, res, next) => {
    if (!fs.existsSync(o.mapFile)) return res.status(404).end();
    res.sendFile(o.mapFile, { acceptRanges: true, maxAge: '1d', cacheControl: true }, (err) => err && next(err));
  });
  // Zoom maximal et zone couverte, lus dans l'en-tête PMTiles v3 (octets 101 à 117)
  let mapInfo = { mtime: 0, maxzoom: 15, bounds: null };
  function readMapInfo() {
    try {
      const st = fs.statSync(o.mapFile);
      if (st.mtimeMs !== mapInfo.mtime) {
        const fd = fs.openSync(o.mapFile, 'r');
        const head = Buffer.alloc(127);
        fs.readSync(fd, head, 0, 127, 0);
        fs.closeSync(fd);
        const ok = head.toString('latin1', 0, 7) === 'PMTiles' && head[101] > 0 && head[101] <= 20;
        const b = [102, 106, 110, 114].map((i) => head.readInt32LE(i) / 1e7); // lon min, lat min, lon max, lat max
        const validBounds = ok && b[0] < b[2] && b[1] < b[3] && b.every((x) => Math.abs(x) <= 180);
        mapInfo = { mtime: st.mtimeMs, maxzoom: ok ? head[101] : 15, bounds: validBounds ? [[b[1], b[0]], [b[3], b[2]]] : null };
      }
    } catch {
      // carte absente
    }
    return mapInfo;
  }
  // Carte auto-hébergée ne couvrant qu'une partie de la France (ex. Île-de-France sur Render) :
  // OpenStreetMap prend le relais ailleurs
  function mapPartial(info) {
    if (!info.bounds) return false;
    const [[s1, w], [n, e]] = info.bounds;
    return s1 > U.BOUNDS.minLat + 0.5 || w > U.BOUNDS.minLng + 0.5 || n < U.BOUNDS.maxLat - 0.5 || e < U.BOUNDS.maxLng - 0.5;
  }
  app.get('/config.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    if (!fs.existsSync(o.mapFile)) return res.json({ map: 'osm' });
    const info = readMapInfo();
    res.json({ map: 'pmtiles', maxzoom: info.maxzoom, bounds: info.bounds, partial: mapPartial(info) });
  });
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, p) {
      if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Politique de confidentialité et mentions légales (pages sans script)
  const legalTemplates = loadTemplates();
  for (const [route, tpl] of Object.entries(legalTemplates)) {
    app.get(route, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      const own = fs.existsSync(o.mapFile);
      res.type('html').send(renderLegal(tpl, o.legal, { selfHostedMap: own, partialMap: own && mapPartial(readMapInfo()), version: VERSION }));
    });
  }
  app.use((req, res) => res.status(404).type('text').send('Introuvable'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).type('text').send('Erreur'));

  const server = http.createServer(app);
  const io = new Server(server, { serveClient: true, maxHttpBufferSize: 1e5 });

  // Jeton de session d'un compte, ou jeton d'appareil d'un simple visiteur (lecture seule)
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!U.validToken(token)) return next(new Error('jeton invalide'));
    const key = A.sessionKey(token);
    const sess = U.own(db.sessions, key);
    if (sess && U.own(db.users, sess.id) && db.users[sess.id].pass) {
      socket.data.userId = sess.id;
      socket.data.account = true;
      socket.data.session = key;
      if (sess.seen !== today()) {
        sess.seen = today();
        save();
      }
    } else {
      socket.data.userId = U.userIdFromToken(token);
      socket.data.account = false;
    }
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(socket);
    // Rien n'est enregistré pour un simple visiteur : la fiche n'existe qu'après le choix d'un pseudo
    touch(userId);
    syncRooms(userId);

    socket.emit('init', {
      me: { id: userId, nickname: hasNick(userId) ? nick(userId) : '', account: !!socket.data.account },
      groups: groupsFor(userId),
      reports: [...reports.values()].map(publicReport),
      density: lastDensity,
      events: publicEvents(),
      organizerEnabled: organizers.enabled(),
      types: Object.keys(U.REPORT_TYPES),
    });

    const ack = (cb, data) => typeof cb === 'function' && cb(data);
    const fail = (cb, error) => ack(cb, { error });
    // Un message malformé ne doit jamais faire tomber le serveur
    const on = (ev, fn) =>
      socket.on(ev, (d, cb) => {
        if (typeof d === 'function') [d, cb] = [undefined, d];
        const data = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
        // Agir (groupes, position, signalements, votes) demande un compte ; regarder la carte, non
        if (NEED_ACCOUNT.has(ev) && !socket.data.account) return ack(cb, { error: 'Connecte-toi ou crée un compte pour faire ça', auth: true });
        try {
          fn(data, cb);
        } catch (e) {
          o.log.error('Erreur sur', ev, e.message);
          fail(cb, 'Erreur');
        }
      });

    // Changement de pseudo (unique)
    on('profile', (d, cb) => {
      const n = A.cleanName(d.nickname);
      if (!n) return fail(cb, 'Pseudo de 3 à 24 caractères');
      const owner = byName.get(A.nameKey(n));
      if (owner && owner !== userId) return fail(cb, 'Ce pseudo est déjà pris');
      byName.delete(A.nameKey(db.users[userId].nickname));
      db.users[userId].nickname = n;
      byName.set(A.nameKey(n), userId);
      save();
      for (const g of groupsOf(userId)) pushGroupToAll(g);
      ack(cb, { ok: true });
    });

    on('pos', (d) => {
      if (!U.validLatLng(d.lat, d.lng)) return;
      if (rate.limited('pos:' + userId, 30, 60000)) return;
      const mode = d.mode === 'named' ? 'named' : 'anon';
      const acc = typeof d.acc === 'number' && Number.isFinite(d.acc) ? Math.max(0, Math.min(Math.round(d.acc), 5000)) : null;
      positions.set(userId, { lat: d.lat, lng: d.lng, acc, mode, ts: now() });
    });

    on('pos:stop', () => positions.delete(userId));

    on('report', (d, cb) => {
      const type = U.own(U.REPORT_TYPES, d.type) ? d.type : null;
      if (!type) return fail(cb, 'Type inconnu');
      if (!U.validLatLng(d.lat, d.lng)) return fail(cb, 'Position hors de France');
      if (rate.limited('rep:' + userId, 4, 2 * 60000)) return fail(cb, 'Trop de signalements, patiente un peu');
      const t = now();
      const r = {
        id: uid(),
        type,
        lat: d.lat,
        lng: d.lng,
        note: U.cleanText(d.note, 140),
        heading: type === 'cortege' ? U.validHeading(d.heading) : null,
        createdAt: t,
        expiresAt: t + U.REPORT_TYPES[type].ttl * 60000,
        up: 1,
        down: 0,
        voters: new Map([[userId, 1]]),
      };
      reports.set(r.id, r);
      queueReport('add', r);
      ack(cb, { ok: true, id: r.id });
    });

    on('vote', (d, cb) => {
      const r = typeof d.id === 'string' ? reports.get(d.id) : undefined;
      if (!r) return fail(cb, 'Signalement expiré');
      const v = d.v === 1 ? 1 : -1;
      const prev = r.voters.get(userId);
      if (prev === v) return ack(cb, { ok: true });
      if (prev === 1) r.up--;
      if (prev === -1) r.down--;
      r.voters.set(userId, v);
      if (v === 1) {
        r.up++;
        r.expiresAt = Math.max(r.expiresAt, now() + VOTE_EXTEND);
      } else r.down++;
      if (r.down >= 3 && r.down > r.up) {
        reports.delete(r.id);
        queueReport('remove', r.id);
      } else queueReport('update', r);
      ack(cb, { ok: true });
    });

    // ----- Groupes -----
    on('group:create', (d, cb) => {
      const name = U.cleanText(d.name, 40);
      if (!name) return fail(cb, 'Nom requis');
      if (!hasNick(userId)) return fail(cb, 'Choisis d’abord un pseudo');
      if (rate.limited('gc:' + userId, 5, 3600000)) return fail(cb, 'Trop de groupes créés');
      const g = {
        id: uid(),
        name,
        description: U.cleanText(d.description, 140),
        code: U.inviteCode(),
        createdAt: now(),
        active: today(),
        members: { [userId]: { role: 'admin', at: now() } },
        pending: {},
      };
      db.groups[g.id] = g;
      indexGroup(g);
      save();
      syncRooms(userId);
      pushGroups(userId);
      ack(cb, { ok: true, id: g.id });
    });

    on('group:join', (d, cb) => {
      const code = U.normalizeCode(d.code);
      // Par appareil : 10/h. Par IP : très large, car les opérateurs mobiles partagent une même IP entre
      // des milliers d'abonné·es (CGNAT) — tout un cortège qui scanne des QR codes ne doit pas être bloqué.
      if (rate.limited('gj:' + userId, 10, 3600000) || rate.limited('gjip:' + clientIp(socket), 10000, 3600000))
        return fail(cb, 'Trop de demandes');
      if (!hasNick(userId)) return fail(cb, 'Choisis d’abord un pseudo');
      const g = code.length === 8 ? getGroup(byCode.get(code)) : null;
      if (!g) return fail(cb, 'Code invalide');
      if (member(g, userId)) return fail(cb, 'Tu es déjà membre');
      if (pendingOf(g, userId)) return ack(cb, { ok: true, name: g.name });
      g.pending[userId] = { at: now() };
      link(userId, g.id);
      save();
      pushGroupToAll(g);
      for (const [id, m] of Object.entries(g.members))
        if (m.role === 'admin') emitToUser(id, 'notify', { kind: 'request', text: `${nick(userId)} demande à rejoindre « ${g.name} »` });
      ack(cb, { ok: true, name: g.name });
    });

    const adminAction = (fn) => (d, cb) => {
      const g = getGroup(d.groupId);
      if (!isAdmin(g, userId)) return fail(cb, 'Réservé aux administrateurs');
      const res = fn(g, d);
      if (res && res.error) return fail(cb, res.error);
      save();
      if (getGroup(g.id)) pushGroupToAll(g);
      ack(cb, { ok: true });
    };

    on('group:approve', adminAction((g, d) => {
      if (!pendingOf(g, d.userId)) return { error: 'Demande introuvable' };
      delete g.pending[d.userId];
      g.members[d.userId] = { role: 'member', at: now() };
      syncRooms(d.userId);
      emitToUser(d.userId, 'notify', { kind: 'ok', text: `Tu as été accepté·e dans « ${g.name} »` });
    }));

    on('group:reject', adminAction((g, d) => {
      if (!pendingOf(g, d.userId)) return { error: 'Demande introuvable' };
      delete g.pending[d.userId];
      unlink(d.userId, g.id);
      pushGroups(d.userId);
      emitToUser(d.userId, 'notify', { kind: 'info', text: `Ta demande pour « ${g.name} » a été refusée` });
    }));

    on('group:kick', adminAction((g, d) => {
      if (!member(g, d.userId) || d.userId === userId) return { error: 'Impossible' };
      delete g.members[d.userId];
      unlink(d.userId, g.id);
      syncRooms(d.userId);
      pushGroups(d.userId);
    }));

    on('group:promote', adminAction((g, d) => {
      const m = member(g, d.userId);
      if (!m) return { error: 'Membre introuvable' };
      m.role = m.role === 'admin' ? 'member' : 'admin';
      if (!Object.values(g.members).some((x) => x.role === 'admin')) {
        m.role = 'admin';
        return { error: 'Il faut au moins un administrateur' };
      }
    }));

    // Point de rendez-vous du groupe (d.clear pour l'enlever)
    on('group:meet', adminAction((g, d) => {
      if (d.clear) {
        delete g.meet;
        return;
      }
      if (!U.validLatLng(d.lat, d.lng)) return { error: 'Position hors de France' };
      const time = U.isValidTime(d.time) ? d.time : '';
      // Date facultative (rendez-vous d'un autre jour, y compris non déclaré) : visible du groupe uniquement
      const date = U.isValidDate(d.date) && d.date >= U.parisDate(now()) ? d.date : '';
      g.meet = { lat: d.lat, lng: d.lng, label: U.cleanText(d.label, 60), note: U.cleanText(d.note, 200), date, time, by: nick(userId), at: now() };
      const when = [date && new Date(date + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), time && 'à ' + time].filter(Boolean).join(' ');
      for (const id of Object.keys(g.members))
        if (id !== userId) emitToUser(id, 'notify', { kind: 'meet', text: `📍 Nouveau rendez-vous pour « ${g.name} »${when ? ' ' + when : ''}` });
    }));

    on('group:code', adminAction((g) => {
      byCode.delete(g.code);
      g.code = U.inviteCode();
      byCode.set(g.code, g.id);
    }));

    on('group:delete', adminAction((g) => {
      const ids = [...Object.keys(g.members), ...Object.keys(g.pending)];
      dropGroup(g);
      ids.forEach((id) => {
        syncRooms(id);
        pushGroups(id);
      });
    }));

    on('group:leave', (d, cb) => {
      const g = getGroup(d.groupId);
      if (!g) return fail(cb, 'Groupe introuvable');
      if (pendingOf(g, userId)) {
        delete g.pending[userId];
        unlink(userId, g.id);
      }
      else if (member(g, userId)) removeMember(g, userId);
      save();
      syncRooms(userId);
      pushGroups(userId);
      if (getGroup(g.id)) pushGroupToAll(g);
      ack(cb, { ok: true });
    });

    // ----- Parcours officiels (organisateur·ices) -----
    on('organizer', (d, cb) => {
      // Seuls les échecs comptent (une reconnexion avec la bonne clé n'épuise pas la limite)
      const failKey = 'orgfail:' + clientIp(socket);
      if (rate.count(failKey, 10 * 60000) >= 10) return fail(cb, 'Trop d’essais, réessaie dans 10 min');
      const name = organizers.verify(d.key);
      if (!name) {
        rate.hit(failKey);
        return fail(cb, 'Clé incorrecte');
      }
      socket.data.organizer = name;
      socket.join('organizers');
      ack(cb, { ok: true });
      socket.emit('events:admin', { events: adminEvents(), report: importReport });
    });

    // Vérifie à chaque action que la clé n'a pas été révoquée entre-temps
    const organizerOnly = (fn) => (d, cb) => {
      if (!socket.data.organizer) return fail(cb, 'Réservé aux organisateur·ices');
      if (!organizers.isValid(socket.data.organizer)) {
        socket.data.organizer = null;
        socket.leave('organizers');
        return fail(cb, 'Clé révoquée');
      }
      fn(d, cb);
    };

    // Création ou modification d'une manif (ajout manuel, correction, tracé du parcours)
    on('event:save', organizerOnly((d, cb) => {
      const existing = U.own(db.events, d.id);
      const clean = U.sanitizeEvent({ ...(existing || {}), ...d }, { today: parisToday() });
      if (clean.error) return fail(cb, clean.error);
      const id = existing ? existing.id : uid();
      const status = U.EVENT_STATUSES.includes(d.status) ? d.status : existing ? existing.status : 'published';
      db.events[id] = {
        ...(existing || { source: 'manuel', sourceId: null, createdAt: now() }),
        ...clean,
        id,
        status,
        edited: true, // l'import automatique ne l'écrasera plus
        by: socket.data.organizer, // traçabilité interne (jamais publique)
        updatedAt: now(),
      };
      eventsChanged();
      ack(cb, { ok: true, id });
    }));

    on('event:status', organizerOnly((d, cb) => {
      const e = U.own(db.events, d.id);
      if (!e) return fail(cb, 'Manif introuvable');
      if (!U.EVENT_STATUSES.includes(d.status)) return fail(cb, 'Statut invalide');
      e.status = d.status;
      e.by = socket.data.organizer;
      e.updatedAt = now();
      // décision humaine : l'import automatique ne la changera plus (une manif retirée n'est pas republiée)
      e.manual = true;
      e.autoPublished = false;
      eventsChanged();
      ack(cb, { ok: true });
    }));

    on('event:delete', organizerOnly((d, cb) => {
      if (!U.own(db.events, d.id)) return fail(cb, 'Manif introuvable');
      delete db.events[d.id];
      eventsChanged();
      ack(cb, { ok: true });
    }));

    // Retrait immédiat d'un faux signalement (ex. une fausse « zone calme » qui mène à une nasse)
    on('report:delete', organizerOnly((d, cb) => {
      const r = typeof d.id === 'string' ? reports.get(d.id) : undefined;
      if (!r) return fail(cb, 'Signalement introuvable');
      reports.delete(r.id);
      queueReport('remove', r.id);
      ack(cb, { ok: true });
    }));

    // Tracé automatique d'un parcours à partir d'étapes écrites (« République », « Barbès »…)
    on('route:plan', organizerOnly((d, cb) => {
      if (rate.limited('route:' + socket.data.organizer, 20, 10 * 60000)) return fail(cb, 'Trop de tracés, patiente quelques minutes');
      const near = U.validLatLng(d.lat, d.lng) ? { lat: d.lat, lng: d.lng } : null;
      const steps = typeof d.steps === 'string' ? d.steps.slice(0, 2000) : '';
      routePlanner(steps, { near })
        .then((r) => (r.error ? fail(cb, r.error) : ack(cb, { ok: true, points: r.points, via: r.via, steps: r.steps })))
        .catch((e) => { o.log.error('Tracé :', e.message); fail(cb, 'Tracé impossible pour le moment'); });
    }));

    on('import:run', organizerOnly(async (d, cb) => {
      if (rate.limited('import', 3, 10 * 60000)) return fail(cb, 'Import déjà relancé récemment, patiente un peu');
      ack(cb, { ok: true });
      await runImport();
    }));

    // Droit à l'oubli : supprime tout ce qui concerne l'utilisateur
    // ---------- Comptes ----------
    const ip = clientIp(socket);
    const busy = () => socket.data.authBusy;
    // Opérations scrypt une par une par connexion (évite d'épuiser le processeur)
    const guarded = (fn) => async (d, cb) => {
      if (busy()) return fail(cb, 'Patiente…');
      socket.data.authBusy = true;
      try {
        await fn(d, cb);
      } catch (e) {
        o.log.error('Compte :', e.message);
        fail(cb, 'Erreur');
      } finally {
        socket.data.authBusy = false;
      }
    };
    const tooManyFailures = (name) =>
      rate.count('authfail:' + ip, 10 * 60000) >= 20 || rate.count('authfail:' + A.nameKey(name), 10 * 60000) >= 10;
    const failed = (name, cb, msg) => {
      rate.hit('authfail:' + ip);
      rate.hit('authfail:' + A.nameKey(name));
      fail(cb, msg);
    };
    function openSession(id) {
      const token = A.sessionToken();
      db.sessions[A.sessionKey(token)] = { id, seen: today() };
      return token;
    }

    on('account:register', guarded(async (d, cb) => {
      if (socket.data.account) return fail(cb, 'Déjà connecté·e');
      const name = A.cleanName(d.name);
      if (!name) return fail(cb, 'Pseudo de 3 à 24 caractères');
      if (!A.validPassword(d.password)) return fail(cb, `Mot de passe de ${A.PASSWORD_MIN} caractères minimum`);
      // Beaucoup de téléphones partagent une même IP chez les opérateurs mobiles (CGNAT) : limite large
      if (rate.limited('register:' + ip, o.registerPerIpHour, 3600000)) return fail(cb, 'Trop de comptes créés depuis ce réseau, réessaie plus tard');
      if (byName.has(A.nameKey(name))) return fail(cb, 'Ce pseudo est déjà pris');
      const recovery = A.recoveryCode();
      const [pass, rec] = await Promise.all([A.hashSecret(d.password, o.passwordCost), A.hashSecret(A.normalizeRecovery(recovery), o.passwordCost)]);
      if (byName.has(A.nameKey(name))) return fail(cb, 'Ce pseudo est déjà pris'); // pris pendant le calcul
      const id = 'u' + uid(12);
      db.users[id] = { nickname: name, seen: today(), pass, rec, created: today() };
      byName.set(A.nameKey(name), id);
      const token = openSession(id);
      save();
      ack(cb, { ok: true, token, recovery, name });
    }));

    on('account:login', guarded(async (d, cb) => {
      const name = typeof d.name === 'string' ? d.name.slice(0, 60) : '';
      if (tooManyFailures(name)) return fail(cb, 'Trop d’essais, réessaie dans 10 minutes');
      const id = byName.get(A.nameKey(A.cleanName(name) || name));
      const u = id ? db.users[id] : null;
      // même durée de calcul que le compte existe ou non
      const ok = await A.verifySecret(String(d.password || ''), u ? u.pass : DUMMY_HASH);
      if (!u || !ok) return failed(name, cb, 'Pseudo ou mot de passe incorrect');
      const token = openSession(id);
      u.seen = today();
      save();
      ack(cb, { ok: true, token, name: u.nickname });
    }));

    on('account:recover', guarded(async (d, cb) => {
      const name = typeof d.name === 'string' ? d.name.slice(0, 60) : '';
      if (tooManyFailures(name)) return fail(cb, 'Trop d’essais, réessaie dans 10 minutes');
      if (!A.validPassword(d.password)) return fail(cb, `Nouveau mot de passe de ${A.PASSWORD_MIN} caractères minimum`);
      const id = byName.get(A.nameKey(A.cleanName(name) || name));
      const u = id ? db.users[id] : null;
      const ok = await A.verifySecret(A.normalizeRecovery(d.code), u ? u.rec : DUMMY_HASH);
      if (!u || !ok) return failed(name, cb, 'Pseudo ou code de secours incorrect');
      const recovery = A.recoveryCode();
      [u.pass, u.rec] = await Promise.all([A.hashSecret(d.password, o.passwordCost), A.hashSecret(A.normalizeRecovery(recovery), o.passwordCost)]);
      endSessions(id);
      const token = openSession(id);
      save();
      ack(cb, { ok: true, token, recovery, name: u.nickname });
    }));

    on('account:password', guarded(async (d, cb) => {
      const u = db.users[userId];
      if (!A.validPassword(d.password)) return fail(cb, `Nouveau mot de passe de ${A.PASSWORD_MIN} caractères minimum`);
      if (tooManyFailures(u.nickname)) return fail(cb, 'Trop d’essais, réessaie dans 10 minutes');
      if (!(await A.verifySecret(String(d.old || ''), u.pass))) return failed(u.nickname, cb, 'Mot de passe actuel incorrect');
      u.pass = await A.hashSecret(d.password, o.passwordCost);
      endSessions(userId, socket.data.session); // déconnecte les autres appareils
      save();
      ack(cb, { ok: true });
    }));

    on('account:logout', (d, cb) => {
      delete db.sessions[socket.data.session];
      save();
      ack(cb, { ok: true });
      socket.disconnect(true);
    });

    // Effacement d'urgence (3 touches sur le logo) ou « Effacer toutes mes données » : supprime aussi le compte
    on('forget', (d, cb) => {
      ack(cb, { ok: true });
      deleteUser(userId); // déconnecte aussi tous ses appareils
      for (const s of sockets.get(userId) || []) s.disconnect(true);
    });

    socket.on('disconnect', () => {
      const set = sockets.get(userId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) sockets.delete(userId);
      }
    });
  });

  // ---------- Boucles temps réel ----------
  function cleanup() {
    const t = now();
    for (const [id, p] of positions) if (t - p.ts > POSITION_TTL) positions.delete(id);
    for (const [id, r] of reports)
      if (r.expiresAt < t) {
        reports.delete(id);
        queueReport('remove', id);
      }
    rate.prune();
    // Clés révoquées : les sessions ouvertes perdent l'accès à la liste interne
    for (const s of io.sockets.adapter.rooms.get('organizers') ? [...io.sockets.adapter.rooms.get('organizers')] : []) {
      const sock = io.sockets.sockets.get(s);
      if (sock && !organizers.isValid(sock.data.organizer)) {
        sock.data.organizer = null;
        sock.leave('organizers');
        sock.emit('organizer:revoked');
      }
    }
    // Groupes inactifs depuis N jours et pseudos sans groupe inactifs depuis N jours : supprimés
    const limit = U.dayOf(t - o.inactiveDays * 86400000);
    let pruned = false;
    for (const g of Object.values(db.groups))
      if ((g.active || U.dayOf(g.createdAt)) < limit) {
        const ids = [...Object.keys(g.members), ...Object.keys(g.pending)];
        dropGroup(g);
        ids.forEach(syncRooms);
        pruned = true;
      }
    // Fiches sans compte (ancien format) : même règle que les groupes. Comptes : inutilisés depuis accountDays.
    const accountLimit = U.dayOf(t - o.accountDays * 86400000);
    for (const [id, u] of Object.entries(db.users)) {
      if (sockets.has(id)) continue;
      if (u.pass ? (u.seen || '') < accountLimit : !userGroups.has(id) && (u.seen || '') < limit) {
        deleteUser(id);
        pruned = true;
      }
    }
    for (const [k, sess] of Object.entries(db.sessions))
      if ((sess.seen || '') < accountLimit || !U.own(db.users, sess.id)) {
        delete db.sessions[k];
        pruned = true;
      }
    if (pruned) save();
    // Rendez-vous de groupe datés : retirés le lendemain
    for (const g of Object.values(db.groups))
      if (g.meet && g.meet.date && g.meet.date < U.parisDate(t)) {
        delete g.meet;
        save();
        pushGroupToAll(g);
      }
    // Les manifs (et leur parcours) disparaissent le lendemain
    const day = U.parisDate(t);
    const old = Object.values(db.events).filter((e) => e.date < day);
    if (old.length) {
      old.forEach((e) => delete db.events[e.id]);
      eventsChanged();
    }
  }

  // Positions des membres, envoyées uniquement dans la « salle » du groupe
  function groupTick() {
    for (const g of Object.values(db.groups)) {
      const room = io.sockets.adapter.rooms.get('g:' + g.id);
      if (!room || room.size === 0) continue;
      const list = [];
      for (const id of Object.keys(g.members)) {
        const p = positions.get(id);
        if (!p) continue;
        const named = p.mode === 'named';
        list.push({
          id: named ? id : U.anonId(o.secret, id, g.id),
          nickname: named ? nick(id) : null,
          lat: p.lat,
          lng: p.lng,
          acc: p.acc,
          ts: p.ts,
        });
      }
      io.to('g:' + g.id).emit('group:pos', { groupId: g.id, list });
    }
  }

  // Carte de foule agrégée et publique (pas de position individuelle)
  function densityTick() {
    lastDensity = U.densityCells(positions.values());
    io.emit('density', lastDensity);
  }

  // ---------- Import automatique des manifs ----------
  // Les manifs trouvées arrivent « à valider » ; seules celles publiées par un·e organisateur·ice sont visibles.
  let importing = null;
  function upsertImported(list) {
    let added = 0;
    let updated = 0;
    let published = 0;
    let publicChange = false;
    const today = parisToday();
    for (const raw of list) {
      if (!U.EVENT_SOURCES.includes(raw.source) || typeof raw.sourceId !== 'string' || !raw.sourceId) continue;
      const clean = U.sanitizeEvent(raw, { today });
      if (clean.error) continue;
      const auto = o.autoPublish && raw.auto === true;
      const why = U.cleanText(raw.why, 80);
      const existing = Object.values(db.events).find((e) => e.source === raw.source && e.sourceId === raw.sourceId);
      if (existing) {
        // on ne touche ni aux manifs corrigées à la main, ni aux refusées, ni à celles publiées par un·e organisateur·ice
        if (existing.edited || existing.manual || existing.status === 'rejected') continue;
        if (existing.status === 'published' && !existing.autoPublished) continue;
        const wasPublic = existing.status === 'published';
        Object.assign(existing, clean, { updatedAt: now(), why, autoPublished: auto, status: auto ? 'published' : 'pending' });
        if (wasPublic || auto) publicChange = true;
        if (auto && !wasPublic) published++;
        updated++;
      } else {
        const id = uid();
        db.events[id] = { ...clean, id, source: raw.source, sourceId: raw.sourceId, status: auto ? 'published' : 'pending', autoPublished: auto, why, edited: false, createdAt: now(), updatedAt: now() };
        if (auto) { published++; publicChange = true; }
        added++;
      }
    }
    return { added, updated, published, publicChange };
  }
  async function runImport() {
    if (importing) return importing;
    const importer = o.importer || require('./lib/importers').importAll;
    importing = (async () => {
      const started = now();
      let report;
      let publicChange = false;
      try {
        const res = await importer({ today: parisToday(), now });
        const { publicChange: changed, ...counts } = upsertImported(res.events || []);
        publicChange = changed;
        report = { at: started, ...counts, sources: res.sources || [] };
      } catch (e) {
        report = { at: started, added: 0, updated: 0, error: e.message, sources: [] };
      }
      importReport = report;
      // journal : uniquement des compteurs, jamais de contenu
      o.log.log(`Import des manifs : ${report.added} nouvelles, ${report.updated} mises à jour, ${report.published || 0} publiées automatiquement${report.error ? ', erreur : ' + report.error : ''}`);
      eventsChanged(publicChange);
      return report;
    })();
    try {
      return await importing;
    } finally {
      importing = null;
    }
  }

  const timers = [];
  async function start(port = Number(process.env.PORT) || 3000) {
    // Base distante (Postgres) : chargée avant d'accepter la moindre connexion
    if (!store.loadSync) {
      adopt(await store.load());
      reindex();
      o.log.log(`Base ${store.kind} chargée : ${Object.keys(db.groups).length} groupes`);
    }
    if (o.timers) {
      timers.push(setInterval(cleanup, CLEANUP_TICK), setInterval(groupTick, GROUP_TICK), setInterval(densityTick, DENSITY_TICK));
      if (o.importEvery) {
        timers.push(setTimeout(runImport, 30000), setInterval(runImport, o.importEvery));
      }
    }
    return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
  }
  async function stop() {
    timers.splice(0).forEach((t) => (clearInterval(t), clearTimeout(t)));
    clearTimeout(flushTimer);
    if (saveTimer) await flush();
    await store.close();
    io.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    app, server, io, start, stop, flush,
    ticks: { cleanup, groupTick, densityTick },
    runImport,
    state: { get db() { return db; }, positions, reports, sockets, userGroups, byCode },
  };
}

module.exports = { createServer, CSP };

if (require.main === module) {
  const s = createServer();
  s.start().then((port) => console.log(`Manif Friend sur http://localhost:${port}`), (e) => {
    console.error('Démarrage impossible :', e.message);
    process.exit(1);
  });
  const bye = () => s.stop().then(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
