'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, REPU, near } = require('../helpers');

let s;
before(async () => (s = await startServer()));
after(() => s.stop());

test('signalement : diffusé à tous, sans auteur', async () => {
  const a = await s.connect();
  const b = await s.connect();
  const r = await a.call('report', { type: 'gaz', ...REPU, note: 'Grenades', heading: 90 });
  assert.ok(r.ok && r.id);
  const got = (await b.until('reports', (m) => m.add.some((x) => x.id === r.id))).add.find((x) => x.id === r.id);
  assert.deepEqual(Object.keys(got).sort(), ['createdAt', 'down', 'expiresAt', 'heading', 'id', 'lat', 'lng', 'note', 'type', 'up'].sort());
  assert.equal(got.heading, null, 'la direction ne concerne que le cortège');
  assert.equal(got.up, 1);
  assert.equal(got.expiresAt - got.createdAt, 30 * 60000);
  // un nouveau venu le voit dans l'état initial
  const c = await s.connect();
  assert.ok(c.init.reports.some((x) => x.id === r.id));
});

test('cortège avec direction', async () => {
  const a = await s.connect();
  const r = await a.call('report', { type: 'cortege', ...REPU, heading: 135.2 });
  assert.equal(s.state.reports.get(r.id).heading, 135);
});

test('signalement invalide', async () => {
  const a = await s.connect();
  assert.equal((await a.call('report', { type: 'inconnu', ...REPU })).error, 'Type inconnu');
  assert.equal((await a.call('report', { type: 'gaz', lat: 40.4, lng: -3.7 })).error, 'Position hors de France');
  assert.equal((await a.call('report', { type: 'gaz' })).error, 'Position hors de France');
});

test('votes : confirmation prolonge, 3 infirmations majoritaires suppriment', async () => {
  const author = await s.connect();
  const r = await author.call('report', { type: 'blocage', ...REPU });
  const before = s.state.reports.get(r.id).expiresAt;
  s.clock.advance(40 * 60000);
  const v1 = await s.connect();
  assert.ok((await v1.call('vote', { id: r.id, v: 1 })).ok);
  assert.ok(s.state.reports.get(r.id).expiresAt > before, 'prolongé');
  assert.equal(s.state.reports.get(r.id).up, 2);
  // voter deux fois la même chose ne compte qu'une fois ; changer d'avis déplace le vote
  await v1.call('vote', { id: r.id, v: 1 });
  assert.equal(s.state.reports.get(r.id).up, 2);
  await v1.call('vote', { id: r.id, v: -1 });
  assert.equal(s.state.reports.get(r.id).up, 1);
  assert.equal(s.state.reports.get(r.id).down, 1);
  const v2 = await s.connect();
  const v3 = await s.connect();
  await v2.call('vote', { id: r.id, v: -1 });
  assert.ok(s.state.reports.has(r.id), '2 « plus là » ne suffisent pas');
  await v3.call('vote', { id: r.id, v: -1 });
  assert.equal(s.state.reports.has(r.id), false);
  await author.until('reports', (m) => m.remove.includes(r.id));
  assert.equal((await v3.call('vote', { id: r.id, v: 1 })).error, 'Signalement expiré');
});

test('expiration automatique des signalements', async () => {
  const a = await s.connect();
  const r = await a.call('report', { type: 'cortege', ...REPU });
  s.clock.advance(21 * 60000);
  s.ticks.cleanup();
  assert.equal(s.state.reports.has(r.id), false);
  await a.until('reports', (m) => m.remove.includes(r.id));
});

test('positions : visibles par les membres du groupe uniquement', async () => {
  const { admin, group } = await s.groupWithAdmin('Positions', 'Alice');
  const bob = await s.user('Bob');
  const outsider = await s.user('Inconnu');
  await s.addMember(admin, group, bob);
  admin.socket.emit('pos', { ...REPU, acc: 12, mode: 'named' });
  bob.socket.emit('pos', { ...near(REPU, 0.001), acc: 20, mode: 'anon' });
  outsider.socket.emit('pos', { ...near(REPU, 0.002), mode: 'named' });
  await new Promise((r) => setTimeout(r, 100));
  s.ticks.groupTick();
  const seen = await bob.until('group:pos', (m) => m.groupId === group.id && m.list.length === 2);
  const alice = seen.list.find((p) => p.nickname === 'Alice');
  assert.equal(alice.id, admin.init.me.id);
  assert.equal(alice.acc, 12);
  const anon = seen.list.find((p) => p.nickname === null);
  assert.notEqual(anon.id, bob.init.me.id, 'en anonyme, l’identifiant réel n’est pas envoyé');
  assert.match(anon.id, /^a[0-9a-f]{10}$/);
  assert.ok(!seen.list.some((p) => Math.abs(p.lat - (REPU.lat + 0.002)) < 1e-9), 'pas de position d’un non-membre');
  assert.equal(await outsider.never('group:pos'), null, 'un non-membre ne reçoit rien');
});

test('arrêt du partage et expiration des positions', async () => {
  const { admin, group } = await s.groupWithAdmin('Expiration');
  const bob = await s.user('Bob8');
  await s.addMember(admin, group, bob);
  bob.socket.emit('pos', { ...REPU, mode: 'named' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.state.positions.has(bob.init.me.id));
  bob.socket.emit('pos:stop');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.state.positions.has(bob.init.me.id), false);
  bob.socket.emit('pos', { ...REPU, mode: 'named' });
  await new Promise((r) => setTimeout(r, 50));
  s.clock.advance(5 * 60000 + 1);
  s.ticks.cleanup();
  assert.equal(s.state.positions.has(bob.init.me.id), false, 'expirée après 5 min');
});

test('positions hors France ou malformées ignorées', async () => {
  const c = await s.connect();
  for (const p of [{ lat: 40.4, lng: -3.7 }, { lat: '48.86', lng: '2.35' }, {}, null, { lat: NaN, lng: 2.35 }]) c.socket.emit('pos', p);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.state.positions.has(c.init.me.id), false);
  c.socket.emit('pos', { ...REPU, acc: 1e9, mode: 'bizarre' });
  await new Promise((r) => setTimeout(r, 50));
  const p = s.state.positions.get(c.init.me.id);
  assert.equal(p.acc, 5000, 'précision plafonnée');
  assert.equal(p.mode, 'anon', 'mode inconnu = anonyme');
});

test('carte de foule : seulement les zones de 3 personnes ou plus', async () => {
  s.state.positions.clear();
  const cs = await Promise.all([1, 2, 3, 4, 5].map(() => s.connect()));
  cs.slice(0, 3).forEach((c, i) => c.socket.emit('pos', { lat: 48.86001 + i * 1e-5, lng: 2.35001, mode: 'anon' }));
  cs.slice(3).forEach((c, i) => c.socket.emit('pos', { lat: 48.8901 + i * 1e-5, lng: 2.3401, mode: 'anon' }));
  await new Promise((r) => setTimeout(r, 100));
  s.ticks.densityTick();
  const d = await cs[0].until('density');
  assert.equal(d.length, 1);
  assert.equal(d[0].n, 3);
  assert.deepEqual(Object.keys(d[0]).sort(), ['lat', 'lng', 'n']);
});

test('signalements regroupés : plusieurs envois rapprochés = un seul message', async () => {
  const s2 = await startServer({ reportBatchMs: 200 });
  try {
    const viewer = await s2.connect();
    const cs = await Promise.all([1, 2, 3, 4].map(() => s2.connect()));
    const ids = [];
    for (const c of cs) ids.push((await c.call('report', { type: 'info', ...REPU })).id);
    await cs[0].call('vote', { id: ids[1], v: 1 });
    const m = await viewer.until('reports');
    assert.deepEqual(m.add.map((x) => x.id).sort(), [...ids].sort(), 'les 4 dans le même message');
    assert.equal(m.add.find((x) => x.id === ids[1]).up, 2, 'le vote est fusionné dans l’ajout');
    assert.deepEqual(m.update, []);
    assert.equal(await viewer.never('reports', () => true, 400), null, 'aucun message en double');
  } finally {
    await s2.stop();
  }
});
