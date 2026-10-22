'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, REPU } = require('../helpers');

test('groupes et pseudos survivent au redémarrage ; positions et signalements non', async () => {
  const s = await startServer();
  const { admin, group } = await s.groupWithAdmin('Durable', 'Alice');
  admin.socket.emit('pos', { ...REPU, mode: 'named' });
  await admin.call('report', { type: 'gaz', ...REPU });
  await s.stop();
  const raw = fs.readFileSync(path.join(s.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(String(REPU.lat)), 'aucune position écrite sur disque');
  assert.ok(!raw.includes('gaz'), 'aucun signalement écrit sur disque');
  assert.ok(!raw.includes(admin.token), 'le jeton n’est jamais stocké');

  const s2 = await startServer({ dataDir: s.dataDir });
  try {
    const again = await s2.connect(admin.token);
    assert.equal(again.init.me.nickname, 'Alice');
    assert.ok(again.init.groups.some((g) => g.id === group.id));
    assert.deepEqual(again.init.reports, []);
    assert.equal(s2.state.positions.size, 0);
  } finally {
    await s2.stop();
  }
});

test('base corrompue : démarrage à vide sans planter', async () => {
  const s = await startServer();
  await s.stop();
  fs.writeFileSync(path.join(s.dataDir, 'db.json'), '{pas du json');
  const s2 = await startServer({ dataDir: s.dataDir });
  try {
    const c = await s2.connect();
    assert.deepEqual(c.init.groups, []);
  } finally {
    await s2.stop();
  }
});

test('écriture atomique (fichier temporaire puis renommage)', async () => {
  const s = await startServer();
  await s.user('Alice');
  s.srv.flush();
  assert.ok(fs.existsSync(path.join(s.dataDir, 'db.json')));
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'db.json.tmp')));
  await s.stop();
});

test('groupes inactifs supprimés après 30 jours ; comptes et sessions après un an sans connexion', async () => {
  const s = await startServer();
  try {
    const { admin, group } = await s.groupWithAdmin('Vieux', 'Ancien');
    const solo = await s.user('Solitaire');
    admin.close();
    solo.close();
    await new Promise((r) => setTimeout(r, 100));
    s.clock.advance(29 * 86400000);
    s.ticks.cleanup();
    assert.ok(s.state.db.groups[group.id], 'encore là après 29 jours');
    s.clock.advance(2 * 86400000);
    s.ticks.cleanup();
    assert.equal(s.state.db.groups[group.id], undefined);
    assert.ok(s.state.db.users[admin.init.me.id], 'le compte reste');
    assert.equal(Object.keys(s.state.db.sessions).length, 2, 'la session reste ouverte');
    s.clock.advance(334 * 86400000);
    s.ticks.cleanup();
    assert.ok(s.state.db.users[solo.init.me.id], 'encore là à 364 jours');
    s.clock.advance(2 * 86400000);
    s.ticks.cleanup();
    assert.equal(s.state.db.users[admin.init.me.id], undefined);
    assert.equal(s.state.db.users[solo.init.me.id], undefined);
    assert.deepEqual(s.state.db.sessions, {});
  } finally {
    await s.stop();
  }
});

test('l’activité d’un membre garde le groupe en vie', async () => {
  const s = await startServer();
  try {
    const { admin, group } = await s.groupWithAdmin('Actif', 'Fidèle');
    admin.close();
    s.clock.advance(25 * 86400000);
    await s.connect(admin.token); // reconnexion = activité
    s.clock.advance(25 * 86400000);
    s.ticks.cleanup();
    assert.ok(s.state.db.groups[group.id]);
  } finally {
    await s.stop();
  }
});
