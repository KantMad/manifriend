'use strict';
// Authentification, autorisations et cloisonnement entre groupes
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tryConnect, REPU } = require('../helpers');

let s;
before(async () => (s = await startServer()));
after(() => s.stop());

test('connexion refusée sans jeton valide', async () => {
  for (const auth of [{}, { token: '' }, { token: 'court' }, { token: 'x'.repeat(201) }, { token: 12345678901234567890 }, { token: ['a'.repeat(30)] }, { token: { a: 1 } }]) {
    const err = await tryConnect(s.url, auth);
    assert.ok(err, JSON.stringify(auth));
    assert.equal(err.message, 'jeton invalide');
  }
  assert.equal(await tryConnect(s.url, { token: 'x'.repeat(32) }), null);
});

test('deux jetons différents = deux identités différentes', async () => {
  const a = await s.connect();
  const b = await s.connect();
  assert.notEqual(a.init.me.id, b.init.me.id);
  assert.ok(!a.init.me.id.includes(a.token));
});

test('toutes les actions d’admin sont refusées à un simple membre et à un inconnu', async () => {
  const { admin, group } = await s.groupWithAdmin('Forteresse');
  const member = await s.user('Membre');
  const stranger = await s.user('Étranger');
  const pending = await s.user('EnAttente');
  await s.addMember(admin, group, member);
  await pending.call('group:join', { code: group.code });
  const victim = member.init.me.id;
  const actions = [
    ['group:approve', { userId: pending.init.me.id }],
    ['group:reject', { userId: pending.init.me.id }],
    ['group:kick', { userId: admin.init.me.id }],
    ['group:promote', { userId: victim }],
    ['group:code', {}],
    ['group:delete', {}],
    ['group:meet', { ...REPU, label: 'piège' }],
  ];
  for (const who of [member, stranger, pending]) {
    for (const [ev, data] of actions) {
      const r = await who.call(ev, { groupId: group.id, ...data });
      assert.equal(r.error, 'Réservé aux administrateurs', `${who.nickname} → ${ev}`);
    }
  }
  const g = s.state.db.groups[group.id];
  assert.ok(g, 'groupe intact');
  assert.equal(g.code, group.code, 'code inchangé');
  assert.equal(g.members[admin.init.me.id].role, 'admin');
  assert.equal(g.members[victim].role, 'member', 'pas d’auto-promotion');
  assert.ok(g.pending[pending.init.me.id], 'demande toujours en attente');
  assert.equal(g.meet, undefined);
});

test('être admin d’un groupe ne donne aucun droit sur un autre', async () => {
  const a = await s.groupWithAdmin('Groupe A', 'AdminA');
  const b = await s.groupWithAdmin('Groupe B', 'AdminB');
  assert.equal((await a.admin.call('group:delete', { groupId: b.group.id })).error, 'Réservé aux administrateurs');
  assert.equal((await a.admin.call('group:code', { groupId: b.group.id })).error, 'Réservé aux administrateurs');
  assert.ok(s.state.db.groups[b.group.id]);
});

test('un admin ne peut pas faire entrer quelqu’un qui n’a rien demandé', async () => {
  const { admin, group } = await s.groupWithAdmin('Pas de force');
  const target = await s.user('Cible');
  const r = await admin.call('group:approve', { groupId: group.id, userId: target.init.me.id });
  assert.equal(r.error, 'Demande introuvable');
  assert.equal(s.state.db.groups[group.id].members[target.init.me.id], undefined);
});

test('les positions d’un groupe ne fuient ni vers les autres groupes ni vers les personnes en attente', async () => {
  const a = await s.groupWithAdmin('Fuite A', 'Ali');
  const b = await s.groupWithAdmin('Fuite B', 'Bea');
  const pending = await s.user('Patient');
  await pending.call('group:join', { code: a.group.code });
  a.admin.socket.emit('pos', { ...REPU, mode: 'named' });
  await new Promise((r) => setTimeout(r, 80));
  s.ticks.groupTick();
  assert.equal(await b.admin.never('group:pos', (m) => m.groupId === a.group.id), null);
  assert.equal(await pending.never('group:pos'), null);
});

test('un membre exclu ne reçoit plus les positions', async () => {
  const { admin, group } = await s.groupWithAdmin('Exclusion', 'Chef');
  const bob = await s.user('Exclu');
  await s.addMember(admin, group, bob);
  admin.socket.emit('pos', { ...REPU, mode: 'named' });
  await new Promise((r) => setTimeout(r, 80));
  s.ticks.groupTick();
  await bob.until('group:pos', (m) => m.groupId === group.id);
  await admin.call('group:kick', { groupId: group.id, userId: bob.init.me.id });
  bob.flush('group:pos');
  s.ticks.groupTick();
  assert.equal(await bob.never('group:pos', (m) => m.groupId === group.id), null);
});

test('le code d’invitation et les demandes ne sont visibles que des admins', async () => {
  const { admin, group } = await s.groupWithAdmin('Secrets');
  const bob = await s.user('Curieux');
  await s.addMember(admin, group, bob);
  const view = (await s.connect(bob.token)).init.groups.find((g) => g.id === group.id);
  assert.equal(view.code, undefined);
  assert.equal(view.pending, undefined);
});

test('mode anonyme : identifiant propre à chaque groupe, aucun pseudo', async () => {
  const g1 = await s.groupWithAdmin('Anon 1', 'Admin1');
  const g2 = await s.groupWithAdmin('Anon 2', 'Admin2');
  const ghost = await s.user('Fantôme');
  await s.addMember(g1.admin, g1.group, ghost);
  await s.addMember(g2.admin, g2.group, ghost);
  ghost.socket.emit('pos', { ...REPU, mode: 'anon' });
  await new Promise((r) => setTimeout(r, 80));
  s.ticks.groupTick();
  const m1 = await g1.admin.until('group:pos', (m) => m.groupId === g1.group.id && m.list.length);
  const m2 = await g2.admin.until('group:pos', (m) => m.groupId === g2.group.id && m.list.length);
  const p1 = m1.list[0];
  const p2 = m2.list[0];
  assert.equal(p1.nickname, null);
  assert.notEqual(p1.id, ghost.init.me.id);
  assert.notEqual(p1.id, p2.id, 'impossible de relier la même personne entre deux groupes');
  assert.ok(!JSON.stringify(m1).includes('Fantôme'));
});

test('les signalements ne révèlent ni l’auteur ni les votants', async () => {
  const author = await s.user('Auteur');
  const r = await author.call('report', { type: 'violence', ...REPU });
  const voter = await s.connect();
  await voter.call('vote', { id: r.id, v: 1 });
  const viewer = await s.connect();
  const rep = viewer.init.reports.find((x) => x.id === r.id);
  const json = JSON.stringify(rep);
  assert.ok(!json.includes(author.init.me.id));
  assert.ok(!json.includes(voter.init.me.id));
  assert.ok(!json.includes('Auteur'));
  assert.equal(rep.voters, undefined);
});

test('droit à l’oubli : tout est supprimé et les groupes restent gérables', async () => {
  const { admin, group } = await s.groupWithAdmin('Oubli', 'Partant');
  const bob = await s.user('Restant');
  await s.addMember(admin, group, bob);
  admin.socket.emit('pos', { ...REPU, mode: 'named' });
  await new Promise((r) => setTimeout(r, 50));
  const r = await admin.call('forget');
  assert.ok(r.ok);
  const id = admin.init.me.id;
  assert.equal(s.state.db.users[id], undefined);
  assert.equal(s.state.positions.has(id), false);
  const g = s.state.db.groups[group.id];
  assert.equal(g.members[id], undefined);
  assert.equal(g.members[bob.init.me.id].role, 'admin', 'le restant devient admin');
  await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(admin.socket.connected, false, 'déconnecté');
});

test('manifs : actions d’organisateur·ice refusées à tout le monde sans la clé', async () => {
  const c = await s.user('Pirate');
  for (const [ev, d] of [['event:save', { title: 'Fausse manif', date: '2026-10-18', lat: 48.86, lng: 2.35 }], ['event:status', { id: 'x', status: 'published' }], ['event:delete', { id: 'x' }], ['import:run', {}]])
    assert.equal((await c.call(ev, d)).error, 'Réservé aux organisateur·ices', ev);
  // la clé débloque une seule connexion, pas le jeton
  const o = await s.connect(c.token);
  assert.ok((await o.call('organizer', { key: 'cle-organisateur-de-test' })).ok);
  const other = await s.connect(c.token);
  assert.equal((await other.call('event:save', { title: 'x', date: '2026-10-18', lat: 48.86, lng: 2.35 })).error, 'Réservé aux organisateur·ices');
  assert.equal(await other.never('events:admin'), null);
});
