'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers');

let s;
before(async () => (s = await startServer()));
after(() => s.stop());

test('un visiteur reçoit l’état initial sans pseudo ni fiche enregistrée', async () => {
  const c = await s.guest();
  assert.equal(c.init.me.account, false);
  assert.equal(c.init.me.nickname, '');
  assert.deepEqual(c.init.groups, []);
  assert.ok(Array.isArray(c.init.reports));
  assert.equal(c.init.organizerEnabled, true);
  assert.equal(s.state.db.users[c.init.me.id], undefined, 'aucune fiche pour un simple visiteur');
});

test('compte : obligatoire pour agir ; changement de pseudo unique', async () => {
  const g = await s.guest();
  for (const ev of ['group:create', 'group:join', 'profile', 'report', 'vote', 'group:leave']) {
    const r = await g.call(ev, { name: 'X', code: 'ABCDEFGH', nickname: 'X', type: 'gaz', lat: 48.86, lng: 2.35 });
    assert.equal(r.auth, true, ev);
  }
  assert.equal(Object.keys(s.state.db.groups).filter((id) => s.state.db.groups[id].name === 'X').length, 0);
  const c = await s.account();
  assert.match((await c.call('profile', { nickname: '   ' })).error, /3 à 24/);
  assert.ok((await c.call('profile', { nickname: 'Zoé' })).ok);
  assert.equal(s.state.db.users[c.init.me.id].nickname, 'Zoé');
  const other = await s.account();
  assert.equal((await other.call('profile', { nickname: 'ZOÉ' })).error, 'Ce pseudo est déjà pris');
});

test('le même jeton retrouve son pseudo et ses groupes', async () => {
  const { admin, group } = await s.groupWithAdmin('Persistant');
  const again = await s.connect(admin.token);
  assert.equal(again.init.me.nickname, 'Admin');
  assert.ok(again.init.groups.some((g) => g.id === group.id && g.role === 'admin'));
});

test('création : le créateur est admin et voit le code', async () => {
  const { group } = await s.groupWithAdmin('Les potes', 'Alice');
  assert.equal(group.role, 'admin');
  assert.match(group.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.deepEqual(group.pending, []);
  assert.equal(group.members.length, 1);
});

test('adhésion : demande → en attente → acceptation par un admin', async () => {
  const { admin, group } = await s.groupWithAdmin('Belleville');
  const bob = await s.user('Bob');
  const j = await bob.call('group:join', { code: group.code.toLowerCase() });
  assert.deepEqual(j, { ok: true, name: 'Belleville' });
  const mine = await bob.until('groups', (gs) => gs.some((g) => g.id === group.id));
  const pending = mine.find((g) => g.id === group.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.members, undefined, 'une personne en attente ne voit pas les membres');
  assert.equal(pending.code, undefined);
  const notif = await admin.until('notify', (n) => n.kind === 'request');
  assert.match(notif.text, /Bob demande à rejoindre/);
  const adminView = await admin.until('groups', (gs) => gs.some((g) => g.id === group.id && g.pending.length === 1));
  assert.equal(adminView.find((g) => g.id === group.id).pending[0].nickname, 'Bob');

  // redemander ne crée pas de doublon
  assert.ok((await bob.call('group:join', { code: group.code })).ok);
  assert.equal(Object.keys(s.state.db.groups[group.id].pending).length, 1);

  assert.ok((await admin.call('group:approve', { groupId: group.id, userId: bob.init.me.id })).ok);
  const ok = await bob.until('notify', (n) => n.kind === 'ok');
  assert.match(ok.text, /accepté/);
  const member = (await bob.until('groups', (gs) => gs.some((g) => g.id === group.id && g.status === 'member'))).find((g) => g.id === group.id);
  assert.equal(member.role, 'member');
  assert.equal(member.code, undefined, 'un simple membre ne voit pas le code');
  assert.equal(member.pending, undefined, 'ni les demandes');
  assert.equal(member.members.length, 2);
  assert.equal((await bob.call('group:join', { code: group.code })).error, 'Tu es déjà membre');
});

test('refus d’une demande', async () => {
  const { admin, group } = await s.groupWithAdmin('Refus');
  const eve = await s.user('Eve');
  await eve.call('group:join', { code: group.code });
  assert.ok((await admin.call('group:reject', { groupId: group.id, userId: eve.init.me.id })).ok);
  assert.match((await eve.until('notify', (n) => n.kind === 'info')).text, /refusée/);
  await eve.until('groups', (gs) => !gs.some((g) => g.id === group.id));
  assert.equal((await admin.call('group:reject', { groupId: group.id, userId: eve.init.me.id })).error, 'Demande introuvable');
});

test('code invalide ou inexistant', async () => {
  const c = await s.user('Curieux');
  assert.equal((await c.call('group:join', { code: 'ZZZZZZZZ' })).error, 'Code invalide');
  assert.equal((await c.call('group:join', { code: '' })).error, 'Code invalide');
  assert.equal((await c.call('group:join', {})).error, 'Code invalide');
});

test('nouveau code : l’ancien ne fonctionne plus', async () => {
  const { admin, group } = await s.groupWithAdmin('Rotation');
  assert.ok((await admin.call('group:code', { groupId: group.id })).ok);
  const fresh = (await admin.until('groups', (gs) => gs.some((g) => g.id === group.id && g.code !== group.code))).find((g) => g.id === group.id);
  const c = await s.user('Tard');
  assert.equal((await c.call('group:join', { code: group.code })).error, 'Code invalide');
  assert.ok((await c.call('group:join', { code: fresh.code })).ok);
});

test('promotion, rétrogradation et au moins un admin', async () => {
  const { admin, group } = await s.groupWithAdmin('Admins');
  const bob = await s.user('Bob2');
  await s.addMember(admin, group, bob);
  assert.ok((await admin.call('group:promote', { groupId: group.id, userId: bob.init.me.id })).ok);
  assert.equal(s.state.db.groups[group.id].members[bob.init.me.id].role, 'admin');
  // Bob (admin) rétrograde Admin, puis ne peut pas se rétrograder lui-même s'il est le dernier
  assert.ok((await bob.call('group:promote', { groupId: group.id, userId: admin.init.me.id })).ok);
  assert.equal((await bob.call('group:promote', { groupId: group.id, userId: bob.init.me.id })).error, 'Il faut au moins un administrateur');
  assert.equal(s.state.db.groups[group.id].members[bob.init.me.id].role, 'admin');
});

test('exclusion d’un membre', async () => {
  const { admin, group } = await s.groupWithAdmin('Exclusion');
  const bob = await s.user('Bob3');
  await s.addMember(admin, group, bob);
  assert.equal((await admin.call('group:kick', { groupId: group.id, userId: admin.init.me.id })).error, 'Impossible', 'pas soi-même');
  assert.ok((await admin.call('group:kick', { groupId: group.id, userId: bob.init.me.id })).ok);
  await bob.until('groups', (gs) => !gs.some((g) => g.id === group.id));
  assert.equal(s.state.db.groups[group.id].members[bob.init.me.id], undefined);
});

test('quitter : le dernier admin transmet son rôle, le dernier membre supprime le groupe', async () => {
  const { admin, group } = await s.groupWithAdmin('Départs');
  const bob = await s.user('Bob4');
  await s.addMember(admin, group, bob);
  assert.ok((await admin.call('group:leave', { groupId: group.id })).ok);
  assert.equal(s.state.db.groups[group.id].members[bob.init.me.id].role, 'admin');
  assert.ok((await bob.call('group:leave', { groupId: group.id })).ok);
  assert.equal(s.state.db.groups[group.id], undefined);
  assert.equal((await bob.call('group:leave', { groupId: group.id })).error, 'Groupe introuvable');
});

test('annuler une demande en attente', async () => {
  const { group } = await s.groupWithAdmin('Annulation');
  const c = await s.user('Hésitant');
  await c.call('group:join', { code: group.code });
  assert.ok((await c.call('group:leave', { groupId: group.id })).ok);
  assert.equal(s.state.db.groups[group.id].pending[c.init.me.id], undefined);
});

test('suppression du groupe par un admin', async () => {
  const { admin, group } = await s.groupWithAdmin('Éphémère');
  const bob = await s.user('Bob5');
  await s.addMember(admin, group, bob);
  assert.ok((await admin.call('group:delete', { groupId: group.id })).ok);
  await bob.until('groups', (gs) => !gs.some((g) => g.id === group.id));
  assert.equal(s.state.db.groups[group.id], undefined);
});

test('changer de pseudo met à jour la vue des autres membres', async () => {
  const { admin, group } = await s.groupWithAdmin('Pseudos');
  const bob = await s.user('Bob6');
  await s.addMember(admin, group, bob);
  admin.flush('groups');
  await bob.call('profile', { nickname: 'Robert' });
  await admin.until('groups', (gs) => gs.find((g) => g.id === group.id)?.members.some((m) => m.nickname === 'Robert'));
});

test('point de rendez-vous : fixé par un admin, notifié aux membres, retiré', async () => {
  const { admin, group } = await s.groupWithAdmin('RDV');
  const bob = await s.user('Bob7');
  await s.addMember(admin, group, bob);
  const r = await admin.call('group:meet', { groupId: group.id, lat: 48.8655, lng: 2.3785, label: 'Métro Oberkampf', time: '14:30' });
  assert.ok(r.ok);
  assert.match((await bob.until('notify', (n) => n.kind === 'meet')).text, /14:30/);
  const view = (await bob.until('groups', (gs) => gs.find((g) => g.id === group.id)?.meet)).find((g) => g.id === group.id);
  assert.deepEqual({ ...view.meet, at: 0 }, { lat: 48.8655, lng: 2.3785, label: 'Métro Oberkampf', note: '', date: '', time: '14:30', by: admin.nickname, at: 0 });
  assert.equal((await bob.call('group:meet', { groupId: group.id, lat: 48.86, lng: 2.36 })).error, 'Réservé aux administrateurs');
  assert.equal((await admin.call('group:meet', { groupId: group.id, lat: 40.4, lng: -3.7 })).error, 'Position hors de France');
  await admin.call('group:meet', { groupId: group.id, lat: 48.86, lng: 2.36, time: '25:99' });
  assert.equal(s.state.db.groups[group.id].meet.time, '', 'heure invalide ignorée');
  assert.ok((await admin.call('group:meet', { groupId: group.id, clear: true })).ok);
  assert.equal(s.state.db.groups[group.id].meet, undefined);
});
