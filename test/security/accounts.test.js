'use strict';
// Comptes sans e-mail : pseudo + mot de passe, sessions longues, code de secours.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../helpers');
const A = require('../../lib/accounts');

const PW = 'un-mot-de-passe-solide';

test('création, connexion depuis un autre appareil, pseudo insensible à la casse', async () => {
  const s = await startServer();
  try {
    const g = await s.guest();
    assert.equal(g.init.me.account, false);
    const r = await g.call('account:register', { name: 'Camille', password: PW });
    assert.ok(r.ok);
    assert.match(r.recovery, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const c = await s.guest(r.token);
    assert.equal(c.init.me.account, true);
    assert.equal(c.init.me.nickname, 'Camille');
    // autre appareil
    const other = await s.guest();
    const l = await other.call('account:login', { name: 'camille', password: PW });
    assert.ok(l.ok);
    assert.notEqual(l.token, r.token, 'une session par appareil');
    assert.equal((await s.guest(l.token)).init.me.id, c.init.me.id);
    // pseudo unique
    assert.equal((await (await s.guest()).call('account:register', { name: 'CAMILLE', password: PW })).error, 'Ce pseudo est déjà pris');
  } finally {
    await s.stop();
  }
});

test('règles : pseudo de 3 à 24 caractères, mot de passe d’au moins 8', async () => {
  const s = await startServer();
  try {
    const g = await s.guest();
    assert.match((await g.call('account:register', { name: 'ab', password: PW })).error, /3 à 24/);
    assert.match((await g.call('account:register', { name: '...', password: PW })).error, /3 à 24/);
    assert.match((await g.call('account:register', { name: 'Correct', password: 'court' })).error, /8 caractères/);
    assert.match((await g.call('account:register', { name: 'Correct', password: { toString: 1 } })).error, /8 caractères/);
    assert.match((await g.call('account:register', { name: 'Correct', password: 'x'.repeat(201) })).error, /8 caractères/);
  } finally {
    await s.stop();
  }
});

test('la base ne contient ni mot de passe, ni code de secours, ni jeton de session en clair', async () => {
  const s = await startServer();
  const c = await s.user('Secret');
  await s.stop();
  const raw = fs.readFileSync(path.join(s.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes('mot-de-passe-test'));
  assert.ok(!raw.includes(c.recovery.replace(/-/g, '')) && !raw.includes(c.recovery));
  assert.ok(!raw.includes(c.token));
  assert.ok(raw.includes(A.sessionKey(c.token)), 'seule l’empreinte du jeton est gardée');
  // la session survit au redémarrage
  const s2 = await startServer({ dataDir: s.dataDir });
  try {
    assert.equal((await s2.guest(c.token)).init.me.account, true);
  } finally {
    await s2.stop();
  }
});

test('mauvais mot de passe : message identique que le pseudo existe ou non ; essais limités', async () => {
  const s = await startServer();
  try {
    await s.user('Cible');
    const g = await s.guest();
    const a = await g.call('account:login', { name: 'Cible', password: 'mauvais-mdp' });
    const b = await g.call('account:login', { name: 'Personne', password: 'mauvais-mdp' });
    assert.equal(a.error, 'Pseudo ou mot de passe incorrect');
    assert.equal(b.error, a.error);
    for (let i = 0; i < 9; i++) await g.call('account:login', { name: 'Cible', password: 'mauvais-' + i });
    assert.match((await g.call('account:login', { name: 'Cible', password: 'mot-de-passe-test' })).error, /Trop d’essais/, 'bloqué même avec le bon mot de passe');
    s.clock.advance(10 * 60000 + 1);
    assert.ok((await g.call('account:login', { name: 'Cible', password: 'mot-de-passe-test' })).ok, 'débloqué après 10 minutes');
  } finally {
    await s.stop();
  }
});

test('code de secours : nouveau mot de passe, nouveau code, autres appareils déconnectés', async () => {
  const s = await startServer();
  try {
    const c = await s.user('Oublieux');
    const g = await s.guest();
    assert.equal((await g.call('account:recover', { name: 'Oublieux', code: 'AAAA-AAAA-AAAA-AAAA', password: 'nouveau-mdp-1' })).error, 'Pseudo ou code de secours incorrect');
    const kicked = new Promise((r) => c.socket.once('disconnect', r));
    const r = await g.call('account:recover', { name: 'oublieux', code: c.recovery.toLowerCase().replace(/-/g, ' '), password: 'nouveau-mdp-1' });
    assert.ok(r.ok);
    assert.notEqual(r.recovery, c.recovery, 'le code utilisé est remplacé');
    await kicked;
    assert.equal((await s.guest(c.token)).init.me.account, false, 'ancienne session fermée');
    assert.ok((await (await s.guest()).call('account:login', { name: 'Oublieux', password: 'nouveau-mdp-1' })).ok);
    assert.ok((await g.call('account:recover', { name: 'Oublieux', code: c.recovery, password: 'encore-autre' })).error, 'ancien code inutilisable');
  } finally {
    await s.stop();
  }
});

test('changement de mot de passe : ancien exigé, autres sessions fermées, celle-ci gardée', async () => {
  const s = await startServer();
  try {
    const c = await s.user('Prudent');
    const other = await s.guest((await (await s.guest()).call('account:login', { name: 'Prudent', password: 'mot-de-passe-test' })).token);
    assert.equal((await c.call('account:password', { old: 'faux-faux-faux', password: 'nouveau-mdp-2' })).error, 'Mot de passe actuel incorrect');
    const kicked = new Promise((r) => other.socket.once('disconnect', r));
    assert.ok((await c.call('account:password', { old: 'mot-de-passe-test', password: 'nouveau-mdp-2' })).ok);
    await kicked;
    assert.equal((await s.guest(c.token)).init.me.account, true, 'cet appareil reste connecté');
    assert.equal((await s.guest(other.token)).init.me.account, false);
  } finally {
    await s.stop();
  }
});

test('déconnexion : la session est supprimée ; effacement d’urgence : le compte disparaît', async () => {
  const s = await startServer();
  try {
    const c = await s.user('Sortant');
    assert.ok((await c.call('account:logout')).ok);
    assert.equal((await s.guest(c.token)).init.me.account, false);
    const { admin, group } = await s.groupWithAdmin('Urgence', 'Pressé');
    const r = await admin.call('forget');
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(s.state.db.users[admin.init.me.id], undefined);
    assert.equal(s.state.db.groups[group.id], undefined);
    assert.ok(!Object.values(s.state.db.sessions).some((x) => x.id === admin.init.me.id));
    // le pseudo est de nouveau libre
    assert.ok((await (await s.guest()).call('account:register', { name: 'Pressé', password: PW })).ok);
  } finally {
    await s.stop();
  }
});

test('jeton de session inventé ou d’un autre format : simple visiteur', async () => {
  const s = await startServer();
  try {
    const g = await s.guest('x'.repeat(32));
    assert.equal(g.init.me.account, false);
    assert.ok((await g.call('report', { type: 'gaz', lat: 48.86, lng: 2.35 })).auth);
  } finally {
    await s.stop();
  }
});

test('empreintes scrypt : vérification correcte, format altéré refusé', async () => {
  const h = await A.hashSecret('secret-123', 1024);
  assert.ok(await A.verifySecret('secret-123', h));
  assert.equal(await A.verifySecret('secret-124', h), false);
  assert.equal(await A.verifySecret('secret-123', 'scrypt$999999999$a$b'), false);
  assert.equal(await A.verifySecret('secret-123', null), false);
  assert.equal(A.nameKey('  Zoé  Martin '), 'zoé martin');
});
