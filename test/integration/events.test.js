'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers');

const KEY = 'cle-organisateur-de-test';
const PTS = [[48.8674, 2.3631], [48.8622, 2.3735], [48.8484, 2.3958]];
const imported = (over = {}) => ({ source: 'demosphere', sourceId: 'rv/1', title: 'Manif à Lyon', date: '2026-10-18', time: '14:00', place: 'Place Bellecour', city: 'Lyon', lat: 45.7576, lng: 4.8320, approx: false, url: 'https://lyon.example/rv/1', ...over });

async function orga(s) {
  const c = await s.connect();
  assert.ok((await c.call('organizer', { key: KEY })).ok);
  await c.next('events:admin');
  return c;
}

test('ajout manuel : publié et diffusé à tous, avec parcours', async () => {
  const s = await startServer();
  try {
    const o = await orga(s);
    const viewer = await s.connect();
    const r = await o.call('event:save', { title: 'République → Nation', date: '2026-10-18', time: '14:00', place: 'Place de la République', lat: 48.8674, lng: 2.3631, points: PTS, note: 'Dispersion à Nation' });
    assert.ok(r.ok);
    const list = await viewer.until('events', (es) => es.some((e) => e.id === r.id));
    const e = list.find((x) => x.id === r.id);
    assert.deepEqual({ ...e }, { id: r.id, title: 'République → Nation', date: '2026-10-18', time: '14:00', place: 'Place de la République', city: '', note: 'Dispersion à Nation', url: '', lat: 48.8674, lng: 2.3631, approx: false, points: PTS, source: 'manuel' });
    assert.equal(e.status, undefined, 'le statut interne n’est pas public');
    const later = await s.connect();
    assert.ok(later.init.events.some((x) => x.id === r.id));
    // modification puis suppression du parcours
    assert.ok((await o.call('event:save', { id: r.id, points: [] })).ok);
    assert.equal(s.state.db.events[r.id].points, null);
    assert.equal(s.state.db.events[r.id].title, 'République → Nation', 'les autres champs sont conservés');
  } finally {
    await s.stop();
  }
});

test('ajout manuel invalide', async () => {
  const s = await startServer();
  try {
    const o = await orga(s);
    const base = { title: 'x', date: '2026-10-18', lat: 48.86, lng: 2.35 };
    assert.equal((await o.call('event:save', { ...base, title: '' })).error, 'Titre requis');
    assert.equal((await o.call('event:save', { ...base, date: '18/10' })).error, 'Date invalide');
    assert.equal((await o.call('event:save', { ...base, date: '2026-10-16' })).error, 'Date passée');
    assert.equal((await o.call('event:save', { ...base, lat: 40.4, lng: -3.7 })).error, 'Lieu de départ hors de France');
    assert.match((await o.call('event:save', { ...base, points: [[48.86, 2.35]] })).error, /Parcours invalide/);
    const ok = await o.call('event:save', { ...base, time: '25:00', url: 'javascript:alert(1)' });
    assert.equal(s.state.db.events[ok.id].time, '');
    assert.equal(s.state.db.events[ok.id].url, '', 'lien javascript: neutralisé');
  } finally {
    await s.stop();
  }
});

test('import : les manifs arrivent « à valider », invisibles du public jusqu’à publication', async () => {
  let batch = [imported(), imported({ sourceId: 'rv/2', title: 'Rassemblement à Marseille', lat: 43.2965, lng: 5.3698, city: 'Marseille' }),
    imported({ sourceId: 'rv/3', title: 'Passée', date: '2026-10-10' }), imported({ sourceId: 'rv/4', lat: 40.4, lng: -3.7 }),
    imported({ sourceId: '', title: 'Sans identifiant' }), imported({ source: 'inconnue', sourceId: 'x' }), imported({ sourceId: 'rv/5', url: 'javascript:alert(1)', title: 'Lien piégé' })];
  const s = await startServer({ importer: async () => ({ events: batch, sources: [{ name: 'Démosphère test', ok: true, found: 7, kept: 7 }] }) });
  try {
    const o = await orga(s);
    const viewer = await s.connect();
    const report = await s.srv.runImport();
    assert.equal(report.added, 3, 'passée, hors France, sans identifiant et source inconnue écartées');
    const admin = await o.until('events:admin', (d) => d.events.length === 3);
    assert.ok(admin.events.every((e) => e.status === 'pending'));
    assert.equal(admin.report.sources[0].name, 'Démosphère test');
    assert.equal(admin.events.find((e) => e.title === 'Lien piégé').url, '');
    assert.deepEqual((await s.connect()).init.events, [], 'rien de public');
    assert.equal(await viewer.never('events:admin'), null, 'un visiteur ne reçoit jamais la liste interne');

    const lyon = admin.events.find((e) => e.title === 'Manif à Lyon');
    assert.ok((await o.call('event:status', { id: lyon.id, status: 'published' })).ok);
    const pub = await viewer.until('events', (es) => es.length === 1);
    assert.equal(pub[0].title, 'Manif à Lyon');
    const mars = admin.events.find((e) => e.title === 'Rassemblement à Marseille');
    assert.ok((await o.call('event:status', { id: mars.id, status: 'rejected' })).ok);
    assert.equal((await o.call('event:status', { id: mars.id, status: 'bidon' })).error, 'Statut invalide');

    // nouvel import : ni la publiée, ni la refusée ne sont modifiées ; une en attente est mise à jour
    batch = [imported({ title: 'Titre modifié par la source' }), imported({ sourceId: 'rv/2', title: 'Marseille bis' }), imported({ sourceId: 'rv/5', title: 'Lien piégé (maj)', url: 'https://ok.example' })];
    const r2 = await s.srv.runImport();
    assert.deepEqual([r2.added, r2.updated], [0, 1]);
    const evs = Object.values(s.state.db.events);
    assert.equal(evs.find((e) => e.sourceId === 'rv/1').title, 'Manif à Lyon');
    assert.equal(evs.find((e) => e.sourceId === 'rv/2').status, 'rejected');
    assert.equal(evs.find((e) => e.sourceId === 'rv/5').title, 'Lien piégé (maj)');

    // une manif corrigée à la main n'est plus écrasée par l'import
    const piege = evs.find((e) => e.sourceId === 'rv/5');
    await o.call('event:save', { id: piege.id, title: 'Corrigé à la main' });
    batch = [imported({ sourceId: 'rv/5', title: 'Écrasement ?' })];
    await s.srv.runImport();
    assert.equal(s.state.db.events[piege.id].title, 'Corrigé à la main');
    assert.equal(s.state.db.events[piege.id].status, 'pending', 'le statut reste celui choisi');
  } finally {
    await s.stop();
  }
});

test('import en échec : rapport d’erreur, aucune donnée perdue', async () => {
  const s = await startServer({ importer: async () => { throw new Error('réseau coupé'); } });
  try {
    const o = await orga(s);
    await o.call('event:save', { title: 'Gardée', date: '2026-10-18', lat: 48.86, lng: 2.35 });
    const r = await s.srv.runImport();
    assert.equal(r.error, 'réseau coupé');
    assert.equal(Object.keys(s.state.db.events).length, 1);
    const d = await o.until('events:admin', (x) => x.report && x.report.error);
    assert.equal(d.report.error, 'réseau coupé');
  } finally {
    await s.stop();
  }
});

test('relance de l’import par un·e organisateur·ice, limitée', async () => {
  let n = 0;
  const s = await startServer({ importer: async () => (n++, { events: [], sources: [] }) });
  try {
    const o = await orga(s);
    for (let i = 0; i < 3; i++) assert.ok((await o.call('import:run')).ok);
    assert.match((await o.call('import:run')).error, /patiente/);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(n >= 1);
  } finally {
    await s.stop();
  }
});

test('suppression et expiration le lendemain', async () => {
  const s = await startServer();
  try {
    const o = await orga(s);
    const a = await o.call('event:save', { title: 'Aujourd’hui', date: '2026-10-17', lat: 48.86, lng: 2.35 });
    const b = await o.call('event:save', { title: 'À supprimer', date: '2026-10-20', lat: 48.86, lng: 2.35 });
    assert.ok((await o.call('event:delete', { id: b.id })).ok);
    assert.equal((await o.call('event:delete', { id: b.id })).error, 'Manif introuvable');
    s.ticks.cleanup();
    assert.ok(s.state.db.events[a.id]);
    s.clock.advance(24 * 3600000);
    s.ticks.cleanup();
    assert.equal(s.state.db.events[a.id], undefined);
  } finally {
    await s.stop();
  }
});

test('ancien format de base (parcours) migré sans erreur', async () => {
  const fs = require('fs');
  const path = require('path');
  const s = await startServer();
  await s.stop();
  fs.writeFileSync(path.join(s.dataDir, 'db.json'), JSON.stringify({ users: {}, groups: {}, routes: { r1: { id: 'r1' } } }));
  const s2 = await startServer({ dataDir: s.dataDir });
  try {
    assert.equal(s2.state.db.routes, undefined);
    assert.deepEqual(s2.state.db.events, {});
  } finally {
    await s2.stop();
  }
});

test('rendez-vous de groupe daté (non officiel) : groupe uniquement, expiré après la date', async () => {
  const s = await startServer();
  try {
    const { admin, group } = await s.groupWithAdmin('Privé', 'Admin');
    const bob = await s.user('Bob');
    const outsider = await s.user('Dehors');
    await s.addMember(admin, group, bob);
    assert.ok((await admin.call('group:meet', { groupId: group.id, lat: 48.86, lng: 2.35, label: 'Devant le lycée', date: '2026-10-19', time: '08:00', note: 'Rassemblement non déclaré' })).ok);
    const notif = await bob.until('notify', (n) => n.kind === 'meet');
    assert.match(notif.text, /lundi 19 octobre à 08:00/);
    const meet = s.state.db.groups[group.id].meet;
    assert.equal(meet.date, '2026-10-19');
    assert.equal(meet.note, 'Rassemblement non déclaré');
    // jamais public : ni dans les manifs, ni chez un non-membre
    const v = await s.connect(outsider.token);
    assert.deepEqual(v.init.events, []);
    assert.ok(!JSON.stringify(v.init).includes('Devant le lycée'));
    // date passée ignorée
    await admin.call('group:meet', { groupId: group.id, lat: 48.86, lng: 2.35, date: '2026-10-01' });
    assert.equal(s.state.db.groups[group.id].meet.date, '');
    await admin.call('group:meet', { groupId: group.id, lat: 48.86, lng: 2.35, date: '2026-10-19' });
    s.clock.advance(3 * 86400000);
    s.ticks.cleanup();
    assert.equal(s.state.db.groups[group.id].meet, undefined);
  } finally {
    await s.stop();
  }
});

test('tracé automatique : réservé aux organisateur·ices, étapes et centre de carte transmis, limité', async () => {
  const calls = [];
  const routePlanner = async (steps, opts) => {
    calls.push([steps, opts]);
    return /Nulle/.test(steps) ? { error: 'Lieu introuvable : « Nulle part »' } : { points: PTS, via: 'ign', steps: [{ text: 'A' }, { text: 'B' }] };
  };
  const s = await startServer({ routePlanner });
  try {
    const anon = await s.connect();
    assert.match((await anon.call('route:plan', { steps: 'A\nB' })).error, /Réservé/);
    const c = await orga(s);
    const r = await c.call('route:plan', { steps: 'République\nNation', lat: 48.86, lng: 2.35 });
    assert.deepEqual(r, { ok: true, points: PTS, via: 'ign', steps: [{ text: 'A' }, { text: 'B' }] });
    assert.deepEqual(calls[0], ['République\nNation', { near: { lat: 48.86, lng: 2.35 } }]);
    assert.match((await c.call('route:plan', { steps: 'Nulle part\nX' })).error, /introuvable/);
    // centre hors de France ignoré, étapes non textuelles ignorées
    await c.call('route:plan', { steps: { __proto__: 1 }, lat: 10, lng: 10 });
    assert.deepEqual(calls[2], ['', { near: null }]);
    for (let i = 0; i < 20; i++) await c.call('route:plan', { steps: 'A\nB' });
    assert.match((await c.call('route:plan', { steps: 'A\nB' })).error, /Trop de tracés/);
  } finally {
    await s.stop();
  }
});

test('publication automatique : manifs sûres visibles de tous, les autres en attente ; une manif retirée n’est pas republiée', async () => {
  let list = [
    imported({ sourceId: 'sure', title: 'Manifestation sûre', auto: true, why: 'publiée automatiquement' }),
    imported({ sourceId: 'douteuse', title: 'Rassemblement douteux', auto: false, why: 'lieu approximatif' }),
  ];
  const s = await startServer({ importer: async () => ({ events: list, sources: [] }) });
  try {
    const viewer = await s.guest();
    const pub = viewer.until('events', (evs) => evs.some((e) => e.title === 'Manifestation sûre'));
    const report = await s.srv.runImport();
    assert.equal(report.published, 1);
    const evs = await pub;
    assert.ok(!evs.some((e) => e.title === 'Rassemblement douteux'), 'la douteuse reste privée');
    const c = await orga(s);
    await c.call('organizer', { key: KEY }); // renvoie la liste interne à jour
    const admin = (await c.until('events:admin', (d) => d.events.length === 2)).events;
    assert.equal(admin.find((e) => e.sourceId === 'sure').auto, true);
    assert.equal(admin.find((e) => e.sourceId === 'douteuse').why, 'lieu approximatif');
    // retirée par un·e organisateur·ice : le prochain import ne la republie pas
    const sure = admin.find((e) => e.sourceId === 'sure');
    assert.ok((await c.call('event:status', { id: sure.id, status: 'pending' })).ok);
    await s.srv.runImport();
    assert.equal(s.state.db.events[sure.id].status, 'pending');
    // devenue douteuse à la source (ex. lieu changé en approximatif) : dépubliée
    list = [imported({ sourceId: 'autre', title: 'Marche', auto: true }), imported({ sourceId: 'douteuse', auto: false })];
    await s.srv.runImport();
    const autre = Object.values(s.state.db.events).find((e) => e.sourceId === 'autre');
    assert.equal(autre.status, 'published');
    list = [imported({ sourceId: 'autre', title: 'Marche', auto: false, why: 'lieu approximatif' })];
    await s.srv.runImport();
    assert.equal(autre.status, 'pending');
  } finally {
    await s.stop();
  }
});

test('AUTO_PUBLISH désactivé : tout attend la validation', async () => {
  const s = await startServer({ autoPublish: false, importer: async () => ({ events: [imported({ auto: true })], sources: [] }) });
  try {
    await s.srv.runImport();
    assert.equal(Object.values(s.state.db.events)[0].status, 'pending');
  } finally {
    await s.stop();
  }
});
