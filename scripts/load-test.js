'use strict';
// Test de charge : simule une manif avec N téléphones répartis en groupes de G personnes,
// qui envoient leur position toutes les 5 s et font quelques signalements.
//   node scripts/load-test.js [--clients 3000] [--group 5] [--minutes 3] [--url http://127.0.0.1:3000]
// Sans --url, lance son propre serveur et mesure sa mémoire et son processeur.
const { fork, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('clients', 3000));
const G = Number(arg('group', 5));
const MINUTES = Number(arg('minutes', 3));
const WORKERS = Number(arg('workers', Math.max(2, Math.min(8, os.cpus().length - 1))));
const CENTER = { lat: 48.8622, lng: 2.3735 };

// ---------------------------------------------------------------- travailleur (clients simulés)
if (process.argv[2] === '--worker') {
  const { io } = require('socket.io-client');
  const [url, from, count] = [process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
  const lat = [];
  const stats = { connected: 0, errors: 0, groupPos: 0, reports: 0, reportsFailed: 0, lag: [] };
  const sockets = [];
  const call = (s, ev, d) => new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ error: 'délai', ms: 10000 }), 10000);
    s.emit(ev, d, (r) => {
      clearTimeout(timer);
      resolve({ ...(r || {}), ms: Date.now() - t0 });
    });
  });
  const open = (token) => new Promise((resolve) => {
    const s = io(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.once('init', () => resolve(s));
    s.once('connect_error', () => resolve(null));
  });
  // chaque téléphone crée son compte (pseudo + mot de passe) puis se reconnecte avec sa session
  const connect = (i) => new Promise((resolve) => (async () => {
    const g = await open(`charge-${from + i}-`.padEnd(32, 'x'));
    if (!g) { stats.errors++; return resolve(null); }
    const r = await call(g, 'account:register', { name: `Membre ${from + i}`, password: 'charge-mot-de-passe' });
    g.close();
    if (!r.token) { stats.errors++; return resolve(null); }
    const s = io(url, { auth: { token: r.token }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.once('init', () => resolve(s));
    s.once('connect_error', () => { stats.errors++; resolve(null); });
    s.on('group:pos', (m) => {
      stats.groupPos++;
      const newest = Math.max(0, ...m.list.map((p) => p.ts));
      if (newest) stats.lag.push(Date.now() - newest);
    });
  })());
  (async () => {
    // connexions par vagues (comme une foule qui arrive)
    for (let i = 0; i < count; i += 50) {
      const batch = await Promise.all(Array.from({ length: Math.min(50, count - i) }, (_, k) => connect(i + k)));
      sockets.push(...batch);
    }
    stats.connected = sockets.filter(Boolean).length;
    // groupes : le 1er de chaque bloc de G crée le groupe, les autres demandent à entrer, l'admin accepte
    for (let i = 0; i < sockets.length; i += G) {
      const block = sockets.slice(i, i + G).filter(Boolean);
      if (!block.length) continue;
      const name = 'Groupe ' + (from + i);
      const waitAdmin = (pred) => new Promise((resolve) => {
        const h = (gs) => { const x = gs.find((y) => y.name === name); if (x && pred(x)) { block[0].off('groups', h); resolve(x); } };
        block[0].on('groups', h);
      });
      const created = waitAdmin((x) => !!x.code);
      const pendingAll = waitAdmin((x) => (x.pending || []).length === block.length - 1);
      const g = await call(block[0], 'group:create', { name });
      if (!g.ok) { stats.errors++; continue; }
      // l'admin reçoit la liste de ses groupes à chaque changement : code, puis les G-1 demandes
      const { code } = await Promise.race([created, new Promise((r) => setTimeout(() => r({}), 5000))]);
      if (!code) { stats.errors++; continue; }
      for (const s of block.slice(1)) await call(s, 'group:join', { code });
      const grp = block.length > 1 ? await Promise.race([pendingAll, new Promise((r) => setTimeout(() => r(null), 5000))]) : null;
      for (const p of (grp && grp.pending) || []) await call(block[0], 'group:approve', { groupId: g.id, userId: p.id });
    }
    process.send({ type: 'ready', connected: stats.connected });
    // boucle de manif
    const started = Date.now();
    const tick = setInterval(() => {
      const t = (Date.now() - started) / 1000;
      for (let k = 0; k < sockets.length; k++) {
        const s = sockets[k];
        if (!s) continue;
        // le cortège avance lentement vers l'est ; chacun autour, à ±300 m
        const a = ((from + k) * 2.399) % (2 * Math.PI);
        const r = 0.003 * (((from + k) * 7919) % 100) / 100;
        s.emit('pos', { lat: CENTER.lat + r * Math.sin(a), lng: CENTER.lng + t * 0.00002 + r * Math.cos(a), acc: 15, mode: k % 3 ? 'named' : 'anon' });
      }
    }, 5000);
    const reportTick = setInterval(async () => {
      // ~2 % des téléphones signalent ou votent chaque minute
      for (let k = 0; k < sockets.length; k++) {
        if (!sockets[k] || Math.random() > 0.02 / 6) continue;
        const r = await call(sockets[k], 'report', { type: ['cortege', 'gaz', 'blocage', 'calme'][k % 4], lat: CENTER.lat + (Math.random() - 0.5) * 0.01, lng: CENTER.lng + (Math.random() - 0.5) * 0.01 });
        if (r.ok) { stats.reports++; lat.push(r.ms); } else stats.reportsFailed++;
      }
    }, 10000);
    process.on('message', (m) => {
      if (m === 'stop') {
        clearInterval(tick);
        clearInterval(reportTick);
        sockets.forEach((s) => s && s.close());
        process.send({ type: 'stats', stats: { ...stats, lag: stats.lag.slice(-5000) }, lat });
        setTimeout(() => process.exit(0), 200);
      }
    });
  })();
  return;
}

// ---------------------------------------------------------------- orchestrateur
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

(async () => {
  let url = arg('url', '');
  let server = null;
  const samples = [];
  if (!url) {
    const port = 3900 + Math.floor(Math.random() * 50);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-charge-'));
    const prof = arg('profile', '');
    server = spawn(process.execPath, [...(prof ? ['--cpu-prof', '--cpu-prof-dir', prof] : []), path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, IMPORT_EVERY_MIN: '0', SERVER_SECRET: crypto.randomBytes(16).toString('hex'), PASSWORD_COST: '1024', REGISTER_PER_IP_HOUR: '1000000' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    url = `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 1500));
    // mémoire et processeur du serveur, chaque seconde (Linux : /proc)
    const tick = os.cpus().length && Number(require('child_process').execSync('getconf CLK_TCK').toString()) || 100;
    let last = null;
    setInterval(() => {
      try {
        const st = fs.readFileSync(`/proc/${server.pid}/stat`, 'utf8').split(') ')[1].split(' ');
        const cpu = (Number(st[11]) + Number(st[12])) / tick;
        const rss = Number(fs.readFileSync(`/proc/${server.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;
        const now = Date.now();
        if (last) samples.push({ cpu: ((cpu - last.cpu) / ((now - last.t) / 1000)) * 100, rss });
        last = { cpu, t: now };
      } catch { /* serveur arrêté */ }
    }, 1000).unref();
  }
  console.log(`Test de charge : ${N} téléphones, groupes de ${G}, ${MINUTES} min, ${WORKERS} processus clients → ${url}`);
  const per = Math.ceil(N / WORKERS);
  const t0 = Date.now();
  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    const count = Math.min(per, N - w * per);
    if (count <= 0) break;
    workers.push(fork(__filename, ['--worker', url, String(w * per), String(count)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  }
  const ready = await Promise.all(workers.map((wk) => new Promise((r) => wk.on('message', (m) => m.type === 'ready' && r(m.connected)))));
  const connected = ready.reduce((a, b) => a + b, 0);
  console.log(`${connected}/${N} connectés et en groupes en ${((Date.now() - t0) / 1000).toFixed(0)} s ; manif simulée pendant ${MINUTES} min…`);
  const steady = samples.length;
  await new Promise((r) => setTimeout(r, MINUTES * 60000));
  workers.forEach((wk) => wk.send('stop'));
  const res = await Promise.all(workers.map((wk) => new Promise((r) => wk.on('message', (m) => m.type === 'stats' && r(m)))));
  const lat = res.flatMap((r) => r.lat);
  const lag = res.flatMap((r) => r.stats.lag);
  const sum = (k) => res.reduce((a, r) => a + r.stats[k], 0);
  const run = samples.slice(steady);
  const report = {
    clients: N, connectes: connected, erreurs: sum('errors'),
    signalements: sum('reports'), signalementsRefuses: sum('reportsFailed'),
    signalementMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(0, ...lat) },
    positionsGroupeRecues: sum('groupPos'),
    fraicheurPositionMs: { p50: pct(lag, 50), p95: pct(lag, 95) },
    serveur: run.length ? { cpuMoyen: Math.round(run.reduce((a, s) => a + s.cpu, 0) / run.length), cpuMax: Math.round(Math.max(...run.map((s) => s.cpu))), memoireMaxMo: Math.round(Math.max(...run.map((s) => s.rss))) } : 'non mesuré (--url)',
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_ACTIONS) {
    const sv = report.serveur;
    console.log(`::notice::Charge ${N} téléphones : ${connected} connectés, signalement p95 ${report.signalementMs.p95} ms (max ${report.signalementMs.max}), positions de groupe p95 ${report.fraicheurPositionMs.p95} ms, serveur CPU moyen ${sv.cpuMoyen} % (max ${sv.cpuMax} %), mémoire max ${sv.memoireMaxMo} Mo`);
  }
  if (server) {
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
  }
  const okRun = connected >= N * 0.99 && report.signalementMs.p95 < 1000 && report.signalementsRefuses === 0;
  process.exit(okRun ? 0 : 1);
})();
