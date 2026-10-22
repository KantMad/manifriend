'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../server');

// Coordonnées utiles
const REPU = { lat: 48.8674, lng: 2.3631 };
const near = (p, dLat = 0, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });

const silent = { error() {}, log() {} };
const newToken = () => crypto.randomBytes(24).toString('base64url');

async function startServer(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mf-test-'));
  const clock = { t: opts.startTime || Date.parse('2026-10-17T10:00:00Z') };
  clock.advance = (ms) => (clock.t += ms);
  const srv = createServer({
    dataDir,
    adminKey: 'cle-organisateur-de-test',
    secret: 'secret-de-test',
    timers: false,
    importEvery: 0,
    reportBatchMs: 10,
    importer: async () => ({ events: [], sources: [] }),
    saveDelay: 5,
    now: () => clock.t,
    log: silent,
    mapFile: path.join(dataDir, 'absent.pmtiles'),
    passwordCost: 1024, // scrypt rapide pour les tests
    ...opts,
  });
  const port = await srv.start(0);
  const url = `http://127.0.0.1:${port}`;
  const clients = [];

  // Simple visiteur (sans compte) : peut regarder, pas agir
  async function guest(token = newToken(), extra = {}) {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false, ...extra });
    const c = wrap(socket, token);
    clients.push(c);
    c.init = await c.next('init');
    return c;
  }
  // Avec un jeton : reconnexion avec ce jeton ; sans : nouveau compte
  const connect = (token, extra) => (token ? guest(token, extra) : account());
  // Client connecté à un compte (créé s'il n'existe pas ; avec un jeton : session existante)
  async function user(nickname, token) {
    if (token) return guest(token);
    const g = await guest();
    // pseudo déjà pris par un test précédent sur le même serveur : « Bob 2 », « Bob 3 »…
    let r;
    for (let i = 1; i < 50; i++) {
      r = await g.call('account:register', { name: i === 1 ? nickname : `${nickname} ${i}`, password: 'mot-de-passe-test' });
      if (r.error !== 'Ce pseudo est déjà pris') break;
    }
    if (!r.ok) throw new Error('compte refusé : ' + r.error);
    g.socket.close();
    const c = await guest(r.token);
    c.nickname = r.name;
    c.recovery = r.recovery;
    return c;
  }
  // Admin + groupe
  async function groupWithAdmin(name = 'Groupe test', adminNick = 'Admin') {
    const admin = await user(adminNick);
    const r = await admin.call('group:create', { name });
    const groups = await admin.until('groups', (gs) => gs.some((g) => g.id === r.id));
    const g = groups.find((x) => x.id === r.id);
    return { admin, group: g };
  }
  // Fait entrer un utilisateur dans le groupe (demande + acceptation)
  async function addMember(admin, group, c) {
    const j = await c.call('group:join', { code: group.code });
    if (!j.ok) throw new Error('join: ' + j.error);
    const a = await admin.call('group:approve', { groupId: group.id, userId: c.init.me.id });
    if (!a.ok) throw new Error('approve: ' + a.error);
    await c.until('groups', (gs) => gs.some((g) => g.id === group.id && g.status === 'member'));
  }
  async function stop() {
    clients.forEach((c) => c.socket.close());
    await srv.stop();
  }
  // Compte anonyme pour les tests qui n'ont pas besoin d'un pseudo précis
  let n = 0;
  const account = () => user(`Testeur ${++n}`);
  return { srv, url, port, clock, dataDir, connect, guest, user, account, groupWithAdmin, addMember, stop, state: srv.state, ticks: srv.ticks };
}

function wrap(socket, token) {
  const queues = new Map(); // ev -> messages reçus non consommés
  const waiters = [];
  socket.onAny((ev, data) => {
    const w = waiters.findIndex((x) => x.ev === ev && x.pred(data));
    if (w >= 0) {
      const [x] = waiters.splice(w, 1);
      clearTimeout(x.timer);
      x.resolve(data);
      return;
    }
    if (!queues.has(ev)) queues.set(ev, []);
    queues.get(ev).push(data);
  });
  const c = {
    socket,
    token,
    // Émet un évènement et attend l'accusé de réception
    call(ev, data, timeout = 2000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('pas de réponse à ' + ev)), timeout);
        socket.emit(ev, data, (r) => {
          clearTimeout(t);
          resolve(r);
        });
      });
    },
    // Prochain message `ev` vérifiant `pred` (déjà reçu ou à venir)
    until(ev, pred = () => true, timeout = 2000) {
      const q = queues.get(ev) || [];
      const i = q.findIndex(pred);
      if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((x) => x.timer === timer), 1);
          reject(new Error(`attente de « ${ev} » expirée`));
        }, timeout);
        waiters.push({ ev, pred, resolve, timer });
      });
    },
    next(ev, timeout) {
      return c.until(ev, () => true, timeout);
    },
    // Vérifie qu'aucun message `ev` vérifiant `pred` n'arrive pendant `ms`
    async never(ev, pred = () => true, ms = 300) {
      try {
        const got = await c.until(ev, pred, ms);
        return got;
      } catch {
        return null;
      }
    },
    received(ev) {
      return queues.get(ev) || [];
    },
    flush(ev) {
      queues.delete(ev);
    },
    close() {
      socket.close();
    },
  };
  return c;
}

// Tente une connexion et renvoie l'erreur éventuelle
function tryConnect(url, auth) {
  return new Promise((resolve) => {
    const s = ioClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect', () => {
      s.close();
      resolve(null);
    });
    s.on('connect_error', (e) => {
      s.close();
      resolve(e);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, tryConnect, newToken, REPU, near, sleep };
