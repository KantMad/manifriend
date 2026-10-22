'use strict';
// Entrées malveillantes : pollution de prototype, données malformées, injections, abus
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, REPU, sleep } = require('../helpers');

let s;
before(async () => (s = await startServer()));
after(() => s.stop());

const EVENTS = ['profile', 'pos', 'pos:stop', 'report', 'vote', 'group:create', 'group:join', 'group:approve', 'group:reject',
  'group:kick', 'group:promote', 'group:meet', 'group:code', 'group:delete', 'group:leave', 'organizer', 'event:save', 'event:status', 'event:delete', 'import:run'];
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'];

test('pollution de prototype : identifiants spéciaux refusés sans planter', async () => {
  const { admin } = await s.groupWithAdmin('Proto', 'Admin');
  await admin.call('organizer', { key: 'cle-organisateur-de-test' });
  for (const k of PROTO_KEYS) {
    for (const ev of ['group:approve', 'group:reject', 'group:kick', 'group:promote', 'group:code', 'group:delete', 'group:meet', 'group:leave']) {
      const r = await admin.call(ev, { groupId: k, userId: k, ...REPU });
      assert.ok(r.error, `${ev} avec ${k}`);
    }
    assert.ok((await admin.call('report', { type: k, ...REPU })).error);
    assert.ok((await admin.call('vote', { id: k, v: 1 })).error);
    assert.ok((await admin.call('event:delete', { id: k })).error);
    assert.ok((await admin.call('event:status', { id: k, status: 'published' })).error);
    // un id spécial ne doit jamais remplacer le prototype de la liste des manifs
    const r = await admin.call('event:save', { id: k, title: 'x', date: '2026-10-20', lat: 48.86, lng: 2.35 });
    assert.notEqual(r.id, k);
  }
  assert.equal(Object.getPrototypeOf(s.state.db.events), Object.prototype);
  assert.equal(Object.getPrototypeOf(s.state.db.groups), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal((await s.guest()).init.me.nickname, '', 'le serveur répond toujours');
});

test('membre « __proto__ » dans un groupe réel : refusé', async () => {
  const { admin, group } = await s.groupWithAdmin('Proto2', 'Admin');
  for (const k of PROTO_KEYS) {
    for (const ev of ['group:approve', 'group:reject', 'group:kick', 'group:promote']) {
      const r = await admin.call(ev, { groupId: group.id, userId: k });
      assert.ok(r.error, `${ev} ${k}`);
    }
  }
  const g = s.state.db.groups[group.id];
  assert.equal(Object.getPrototypeOf(g.members), Object.prototype);
  assert.deepEqual(Object.keys(g.members), [admin.init.me.id]);
});

test('fuzzing : données absurdes envoyées à chaque évènement, le serveur tient', async () => {
  const c = await s.user('Fuzzer');
  const payloads = [undefined, null, 0, -1, 1e308, NaN, '', 'x'.repeat(5000), true, [], [1, 2], {}, { a: { b: { c: {} } } },
    { groupId: null, userId: {}, lat: '48', lng: [], type: ['gaz'], id: { $gt: '' }, code: 123, nickname: ['a'], points: 'abc', key: {} },
    { lat: 48.86, lng: 2.35, type: 'gaz', note: { toString: 'x' }, heading: '90' }, Buffer.from('binaire')];
  for (const ev of EVENTS) {
    for (const p of payloads) {
      c.socket.emit(ev, p, () => {});
      c.socket.emit(ev, p); // sans accusé de réception
    }
  }
  c.socket.emit('evenement-inconnu', { x: 1 });
  await sleep(300);
  assert.ok(c.socket.connected, 'toujours connecté');
  const r = await c.call('report', { type: 'info', ...REPU });
  assert.ok(r.ok || r.error, 'le serveur répond encore');
  s.ticks.groupTick();
  s.ticks.densityTick();
  s.ticks.cleanup();
});

test('appel avec seulement une fonction de rappel', async () => {
  const c = await s.connect();
  const r = await new Promise((res) => c.socket.emit('group:create', res));
  assert.equal(r.error, 'Nom requis');
});

test('contenu HTML/JS stocké tel quel en texte (échappé à l’affichage), contrôles retirés', async () => {
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const c = await s.user(xss);
  assert.equal(s.state.db.users[c.init.me.id].nickname, xss.slice(0, 24));
  const { id } = await c.call('group:create', { name: xss, description: xss });
  assert.equal(s.state.db.groups[id].name, xss.slice(0, 40));
  const r = await c.call('report', { type: 'info', ...REPU, note: 'a\u0000b‮c' });
  assert.equal(s.state.reports.get(r.id).note, 'a b c');
});

test('textes tronqués aux longueurs maximales', async () => {
  const c = await s.user('L'.repeat(100));
  assert.equal(s.state.db.users[c.init.me.id].nickname.length, 24);
  const { id } = await c.call('group:create', { name: 'N'.repeat(100), description: 'D'.repeat(1000) });
  assert.equal(s.state.db.groups[id].name.length, 40);
  assert.equal(s.state.db.groups[id].description.length, 140);
  const r = await c.call('report', { type: 'info', ...REPU, note: 'x'.repeat(1000) });
  assert.equal(s.state.reports.get(r.id).note.length, 140);
});

test('message trop gros : connexion coupée, serveur intact', async () => {
  const c = await s.connect();
  const closed = new Promise((r) => c.socket.on('disconnect', r));
  c.socket.emit('report', { type: 'info', ...REPU, note: 'x'.repeat(200000) });
  await closed;
  const other = await s.connect();
  assert.ok(other.init);
});

test('limite : 4 signalements par 2 minutes', async () => {
  const c = await s.connect();
  for (let i = 0; i < 4; i++) assert.ok((await c.call('report', { type: 'info', ...REPU })).ok);
  assert.match((await c.call('report', { type: 'info', ...REPU })).error, /Trop de signalements/);
  s.clock.advance(2 * 60000 + 1);
  assert.ok((await c.call('report', { type: 'info', ...REPU })).ok);
});

test('limite : 5 groupes créés par heure', async () => {
  const c = await s.user('Créateur');
  for (let i = 0; i < 5; i++) assert.ok((await c.call('group:create', { name: 'G' + i })).ok);
  assert.equal((await c.call('group:create', { name: 'G6' })).error, 'Trop de groupes créés');
});

test('limite : force brute des codes d’invitation', async () => {
  const c = await s.user('Brute');
  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await c.call('group:join', { code: 'AAAAAAA' + 'BCDEFGHJKLMN'[i] });
    if (r.error === 'Trop de demandes') blocked = true;
  }
  assert.ok(blocked, 'bloqué après 10 essais par heure');
});

test('CGNAT : des dizaines d’appareils derrière la même IP ne sont pas bloqués, la limite par appareil reste', async () => {
  const s2 = await startServer();
  try {
    for (let i = 0; i < 40; i++) {
      const c = await s2.user('Manifestant' + i);
      assert.equal((await c.call('group:join', { code: 'ZZZZZZZZ' })).error, 'Code invalide', `appareil ${i}`);
    }
    const c = await s2.user('Insistant');
    const errs = [];
    for (let j = 0; j < 12; j++) errs.push((await c.call('group:join', { code: 'ZZZZZZZZ' })).error);
    assert.equal(errs.filter((e) => e === 'Trop de demandes').length, 2, '10 essais par heure et par appareil');
  } finally {
    await s2.stop();
  }
});
test('limite : force brute de la clé organisateur (10 échecs / 10 min / IP), les succès ne comptent pas', async () => {
  const s2 = await startServer();
  try {
    const good = await s2.connect();
    for (let i = 0; i < 20; i++) assert.ok((await good.call('organizer', { key: 'cle-organisateur-de-test' })).ok, 'reconnexions légitimes');
    const results = [];
    for (let i = 0; i < 12; i++) {
      const c = await s2.connect(); // nouveau jeton à chaque fois : ne contourne pas la limite
      results.push((await c.call('organizer', { key: 'essai' + i })).error);
    }
    assert.deepEqual(results.slice(0, 10), Array(10).fill('Clé incorrecte'));
    assert.match(results[10], /Trop d’essais/);
    const c = await s2.connect();
    assert.match((await c.call('organizer', { key: 'cle-organisateur-de-test' })).error, /Trop d’essais/, 'même la bonne clé est bloquée');
    s2.clock.advance(10 * 60000 + 1);
    assert.ok((await c.call('organizer', { key: 'cle-organisateur-de-test' })).ok);
  } finally {
    await s2.stop();
  }
});
test('X-Forwarded-For ignoré hors proxy de confiance (pas de contournement des limites)', async () => {
  const s2 = await startServer();
  try {
    const errs = [];
    for (let i = 0; i < 11; i++) {
      const c = await s2.connect(undefined, { extraHeaders: { 'x-forwarded-for': `10.0.0.${i}` } });
      errs.push((await c.call('organizer', { key: 'x'.repeat(10) })).error);
    }
    assert.match(errs[10], /Trop d’essais/);
  } finally {
    await s2.stop();
  }
});
test('limite : positions (30 par minute)', async () => {
  const c = await s.connect();
  for (let i = 0; i < 40; i++) c.socket.emit('pos', { lat: 48.86 + i * 1e-4, lng: 2.35, mode: 'anon' });
  await sleep(150);
  const p = s.state.positions.get(c.init.me.id);
  assert.ok(Math.abs(p.lat - (48.86 + 29 * 1e-4)) < 1e-9, 'les mises à jour au-delà de 30 sont ignorées');
});
