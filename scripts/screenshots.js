'use strict';
// Captures d'écran de l'appli avec la vraie carte de Paris (map/paris.pmtiles), sur plusieurs appareils.
// Usage : node scripts/screenshots.js [dossier_de_sortie]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { io } = require('socket.io-client');
const { createServer } = require('../server');

const OUT = path.resolve(process.argv[2] || 'screenshots');
// SHOTS_MAP=osm : rendu avec les tuiles OpenStreetMap (hébergement sans carte, ex. Render), téléphone seulement
const OSM = process.env.SHOTS_MAP === 'osm';
const MAP = OSM ? path.join(os.tmpdir(), 'pas-de-carte.pmtiles') : path.join(__dirname, '..', 'map', 'carte.pmtiles');
const REPU = { lat: 48.8674, lng: 2.3631 };

const devices = {
  'telephone': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'petit-telephone': { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'tablette': { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  'tablette-paysage': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  'ordinateur': { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

function connectWith(url, token) {
  const s = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
  const call = (ev, d) => new Promise((r) => s.emit(ev, d, r));
  return new Promise((resolve) => s.once('init', (init) => resolve({ s, call, init, token })));
}
// Compte de démonstration : création puis reconnexion avec la session
async function client(url, token, name) {
  const g = await connectWith(url, token);
  const r = await g.call('account:register', { name: name || 'Démo ' + token.slice(-6), password: 'captures-mot-de-passe' });
  g.s.close();
  return connectWith(url, r.token);
}

(async () => {
  if (!OSM && !fs.existsSync(MAP)) throw new Error('Carte absente : lancer « npm run map » d’abord');
  fs.mkdirSync(OUT, { recursive: true });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const inDays = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  // Manifs « à valider » simulées (l'import réel est testé à part, workflow « sondes »)
  const pending = [
    { source: 'demosphere', sourceId: 'd1', title: 'Manifestation unitaire pour les salaires', date: inDays(1), time: '14:00', place: 'Place Jean Jaurès', city: 'Toulouse', lat: 43.6045, lng: 1.4475, approx: false, url: 'https://toulouse.demosphere.net/rv/1' },
    { source: 'mobilizon', sourceId: 'm1', title: 'Rassemblement pour la Palestine', date: inDays(2), time: '18:00', place: 'Place Kléber', city: 'Strasbourg', lat: 48.5834, lng: 7.7458, approx: false, url: 'https://mobilizon.fr/events/x' },
    { source: 'paris-luttes', sourceId: 'p1', title: 'Manif au départ de République', date: today, time: '14:00', place: 'République', city: 'Paris', lat: 48.8674, lng: 2.3631, approx: true, url: 'https://paris-luttes.info/x' },
  ];
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mf-shots-')), adminKey: 'cle-captures', mapFile: MAP, importEvery: 0, importer: async () => ({ events: pending, sources: [{ name: 'Démosphère (simulé)', ok: true, found: 120, matched: 2, kept: 1 }, { name: 'Mobilizon (simulé)', ok: true, found: 99, matched: 3, kept: 1 }, { name: 'Paris-luttes.info (simulé)', ok: true, found: 86, matched: 1, kept: 1 }] }) });
  const port = await srv.start(0);
  const url = `http://127.0.0.1:${port}`;

  // Données de démonstration : groupe, membres, signalements, parcours, rendez-vous
  const alice = await client(url, 'jeton-alice-'.padEnd(32, 'a'), 'Alice');
  const { id: gid } = await alice.call('group:create', { name: 'Les potes de Belleville', description: 'Cortège de tête' });
  const code = srv.state.db.groups[gid].code;
  for (const [n, lat, lng, mode] of [['Bob', 48.8668, 2.3652, 'named'], ['Camille', 48.8659, 2.3668, 'anon'], ['Dan', 48.8681, 2.3618, 'named']]) {
    const c = await client(url, `jeton-${n}-`.padEnd(32, 'x'), n);
    await c.call('group:join', { code });
    await alice.call('group:approve', { groupId: gid, userId: c.init.me.id });
    c.s.emit('pos', { lat, lng, acc: 15, mode });
  }
  alice.s.emit('pos', { ...REPU, acc: 10, mode: 'named' });
  const reports = [['cortege', 48.8652, 2.3700, 'Tête de cortège', 135], ['gaz', 48.8628, 2.3742, 'Lacrymos boulevard Voltaire'],
    ['violence', 48.8611, 2.3770, 'Charge, éviter'], ['blocage', 48.8695, 2.3575, 'Rue fermée'], ['medic', 48.8665, 2.3612, 'Medics devant la statue'],
    ['calme', 48.8702, 2.3668, 'Sortie possible'], ['nasse', 48.8590, 2.3810, 'Nasse en cours'], ['info', 48.8640, 2.3600, 'Point eau']];
  for (let i = 0; i < reports.length; i++) {
    const [type, lat, lng, note, heading] = reports[i];
    const c = await client(url, `jeton-rapport-${i}-`.padEnd(32, 'r'), `Témoin ${i + 1}`);
    await c.call('report', { type, lat, lng, note, heading });
  }
  await alice.call('organizer', { key: 'cle-captures' });
  await alice.call('event:save', { title: 'Intersyndicale République → Nation', date: today, time: '14:00', place: 'Place de la République', note: 'Dispersion place de la Nation', lat: 48.8674, lng: 2.3631,
    points: [[48.8674, 2.3631], [48.8652, 2.3700], [48.8622, 2.3735], [48.8590, 2.3810], [48.8530, 2.3890], [48.8484, 2.3958]] });
  for (const [title, city, lat, lng, d, time] of [['Marche pour le climat', 'Lyon', 45.7576, 4.832, 0, '14:00'], ['Manifestation contre la réforme', 'Marseille', 43.2951, 5.3756, 1, '10:30'],
    ['Rassemblement devant la préfecture', 'Rennes', 48.1113, -1.6800, 0, '18:00'], ['Grève et manifestation', 'Lille', 50.6365, 3.0635, 3, '14:30'], ['Manif féministe', 'Bordeaux', 44.8412, -0.5800, 5, '15:00'], ['Cortège syndical', 'Nantes', 47.2130, -1.5560, 2, '11:00']])
    await alice.call('event:save', { title, city, place: 'Centre-ville', date: inDays(d), time, lat, lng });
  await srv.runImport();
  await alice.call('group:meet', { groupId: gid, lat: 48.8656, lng: 2.3787, label: 'Métro Oberkampf', time: '14:30' });
  srv.ticks.densityTick();

  const browser = await chromium.launch();
  for (const [name, dev] of Object.entries(devices)) {
    for (const dark of [false, true]) {
      if (dark && name !== 'telephone') continue;
      if (OSM && name !== 'telephone') continue;
      const ctx = await browser.newContext({ ...dev, geolocation: { latitude: REPU.lat + 0.0004, longitude: REPU.lng + 0.001 }, permissions: ['geolocation'] });
      await ctx.addInitScript(([tok, d]) => {
        localStorage.setItem('mf_token', JSON.stringify(tok));
        localStorage.setItem('mf_welcomed', 'true');
        localStorage.setItem('mf_darkMap', JSON.stringify(d));
        localStorage.setItem('mf_view', JSON.stringify({ c: [48.8640, 2.3720], z: 15 }));
      }, [alice.token, dark]);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => console.error(name, 'ERREUR', e.message));
      await p.goto(url + '/');
      await p.waitForSelector('#conn.on');
      srv.ticks.groupTick();
      await p.waitForTimeout(4000); // chargement des tuiles vectorielles
      srv.ticks.groupTick();
      await p.waitForTimeout(800);
      const suffix = dark ? '-sombre' : '';
      await p.screenshot({ path: path.join(OUT, `${name}${suffix}-carte.png`) });
      if (!dark) {
        await p.click('#btn-groups');
        await p.waitForTimeout(500);
        await p.screenshot({ path: path.join(OUT, `${name}-groupes.png`) });
        await p.click('.sheet-close >> visible=true');
        await p.click('.rep-icon >> nth=1', { force: true });
        await p.waitForTimeout(600);
        await p.screenshot({ path: path.join(OUT, `${name}-signalement.png`) });
      }
      // dézoom progressif, comme un vrai utilisateur
      if (name === 'telephone' && !dark) {
        await p.evaluate(() => document.querySelector('.leaflet-popup-close-button')?.click());
        for (let z = 0; z < 3; z++) {
          await p.click('.leaflet-control-zoom-out');
          await p.waitForTimeout(400);
        }
        await p.waitForTimeout(4000);
        await p.screenshot({ path: path.join(OUT, `${name}-dezoom.png`) });
      }
      await ctx.close();
    }
  }
  // France entière, Lyon, liste des manifs et espace organisateur·ices
  {
    const ctx = await browser.newContext(devices.telephone);
    await ctx.addInitScript(() => { localStorage.setItem('mf_welcomed', 'true'); localStorage.setItem('mf_token', JSON.stringify('jeton-orga-'.padEnd(32, 'o'))); });
    const p = await ctx.newPage();
    for (const [name, c, z] of [['france', [46.6, 2.4], 6], ['lyon', [45.7576, 4.832], 15], ['marseille', [43.2951, 5.3756], 14]]) {
      await p.evaluate(([cc, zz]) => localStorage.setItem('mf_view', JSON.stringify({ c: cc, z: zz })), [c, z]).catch(() => {});
      await ctx.addInitScript(([cc, zz]) => localStorage.setItem('mf_view', JSON.stringify({ c: cc, z: zz })), [c, z]);
      await p.goto(url + '/');
      await p.waitForSelector('#conn.on');
      await p.waitForTimeout(4000);
      await p.screenshot({ path: path.join(OUT, `manifs-${name}.png`) });
    }
    await p.click('#btn-layers');
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, 'manifs-liste.png') });
    await p.click('.sheet-close >> visible=true');
    await p.click('#btn-info');
    await p.click('#organizer-box summary');
    await p.fill('#organizer-key', 'cle-captures');
    await p.click('#organizer-form button');
    await p.waitForSelector('#orga-pending .event-item');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, 'organisateurs.png') });
    await p.click('#orga-add');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, 'organisateurs-ajout.png') });
    await ctx.close();
  }
  // vue d'ensemble de Paris chargée directement à chaque niveau de zoom
  for (const z of [12, 13, 14, 16, 17]) {
    const ctx = await browser.newContext(devices.telephone);
    await ctx.addInitScript((zoom) => {
      localStorage.setItem('mf_welcomed', 'true');
      localStorage.setItem('mf_view', JSON.stringify({ c: [48.8600, 2.3500], z: zoom }));
    }, z);
    const p = await ctx.newPage();
    await p.goto(url + '/');
    await p.waitForSelector('#conn.on');
    await p.waitForTimeout(4000);
    await p.screenshot({ path: path.join(OUT, `zoom-${z}.png`) });
    await ctx.close();
  }
  await browser.close();
  await srv.stop();
  console.log('Captures dans', OUT);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::Captures : ${String(e.message || e).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});
