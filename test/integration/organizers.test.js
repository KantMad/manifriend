'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrganizers } = require('../../lib/organizers');
const { startServer, REPU } = require('../helpers');

test('clés individuelles : création, vérification, liste, révocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-orga-'));
  const orgs = createOrganizers({ dataDir: dir, mainKey: 'cle-principale' });
  const k = orgs.add('Camille');
  assert.match(k, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(orgs.verify(k), 'Camille');
  assert.equal(orgs.verify('cle-principale'), 'principal');
  assert.equal(orgs.verify('mauvaise-cle'), null);
  assert.equal(orgs.verify(''), null);
  assert.equal(orgs.verify({}), null);
  assert.throws(() => orgs.add('Camille'), /déjà une clé/);
  assert.throws(() => orgs.add('principal'), /Nom invalide/);
  assert.throws(() => orgs.add('<script>'), /Nom invalide/);
  assert.deepEqual(orgs.list().map((x) => x.name), ['Camille']);
  const raw = fs.readFileSync(path.join(dir, 'organizers.json'), 'utf8');
  assert.ok(!raw.includes(k), 'seule l’empreinte est stockée');
  assert.equal((fs.statSync(path.join(dir, 'organizers.json')).mode & 0o077), 0, 'fichier lisible par le seul propriétaire');
  assert.ok(orgs.remove('Camille'));
  assert.equal(orgs.verify(k), null);
  assert.equal(orgs.remove('Camille'), false);
  assert.equal(createOrganizers({ dataDir: dir }).enabled(), false, 'ni clé principale ni clé individuelle');
});

test('fichier de clés corrompu : aucune clé acceptée, pas de plantage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-orga-'));
  fs.writeFileSync(path.join(dir, 'organizers.json'), '{pas du json');
  const orgs = createOrganizers({ dataDir: dir });
  assert.equal(orgs.verify('nimporte-quoi'), null);
  assert.deepEqual(orgs.list(), []);
});

test('clé individuelle : connexion, traçabilité, révocation immédiate sans redémarrage', async () => {
  const s = await startServer({ adminKey: '' });
  try {
    const orgs = createOrganizers({ dataDir: s.dataDir });
    const key = orgs.add('Camille');
    const c = await s.connect();
    assert.equal(c.init.organizerEnabled, true, 'activé par une clé individuelle seule');
    assert.ok((await c.call('organizer', { key })).ok);
    await c.next('events:admin');
    const r = await c.call('event:save', { title: 'Manif', date: '2026-10-18', lat: 48.86, lng: 2.35 });
    assert.equal(s.state.db.events[r.id].by, 'Camille');
    const adm = await c.until('events:admin', (d) => d.events.length === 1);
    assert.equal(adm.events[0].by, 'Camille', 'visible des organisateur·ices');
    const viewer = await s.connect();
    assert.equal(viewer.init.events[0].by, undefined, 'jamais public');

    // révocation : l'action suivante est refusée, la session est retirée de la liste interne
    orgs.remove('Camille');
    assert.equal((await c.call('event:status', { id: r.id, status: 'pending' })).error, 'Clé révoquée');
    assert.equal((await c.call('event:status', { id: r.id, status: 'pending' })).error, 'Réservé aux organisateur·ices');
    assert.equal((await c.call('organizer', { key })).error, 'Clé incorrecte');
  } finally {
    await s.stop();
  }
});

test('révocation : les sessions inactives sont aussi coupées au prochain nettoyage', async () => {
  const s = await startServer({ adminKey: '' });
  try {
    const orgs = createOrganizers({ dataDir: s.dataDir });
    const key = orgs.add('Dominique');
    const c = await s.connect();
    await c.call('organizer', { key });
    await c.next('events:admin');
    orgs.remove('Dominique');
    s.ticks.cleanup();
    await c.next('organizer:revoked');
    const o2 = await s.connect();
    // une autre organisatrice publie : la session révoquée ne reçoit plus la liste interne
    const k2 = orgs.add('Eden');
    await o2.call('organizer', { key: k2 });
    await o2.call('event:save', { title: 'x', date: '2026-10-18', lat: 48.86, lng: 2.35, status: 'pending' });
    assert.equal(await c.never('events:admin'), null);
  } finally {
    await s.stop();
  }
});

test('suppression d’un signalement : réservée aux organisateur·ices, retirée chez tout le monde', async () => {
  const s = await startServer();
  try {
    const author = await s.connect();
    const viewer = await s.connect();
    const r = await author.call('report', { type: 'calme', ...REPU, note: 'Sortie sûre (faux)' });
    assert.equal((await viewer.call('report:delete', { id: r.id })).error, 'Réservé aux organisateur·ices');
    assert.equal((await author.call('report:delete', { id: r.id })).error, 'Réservé aux organisateur·ices', 'même l’auteur');
    const o = await s.connect();
    await o.call('organizer', { key: 'cle-organisateur-de-test' });
    assert.ok((await o.call('report:delete', { id: r.id })).ok);
    await viewer.until('reports', (m) => m.remove.includes(r.id));
    assert.equal(s.state.reports.has(r.id), false);
    assert.equal((await o.call('report:delete', { id: r.id })).error, 'Signalement introuvable');
    assert.equal((await o.call('report:delete', { id: '__proto__' })).error, 'Signalement introuvable');
  } finally {
    await s.stop();
  }
});
