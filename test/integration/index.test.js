'use strict';
// L'index (personne -> groupes, code -> groupe) doit toujours correspondre exactement à la base.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers');

function expected(db) {
  const ug = new Map();
  const codes = new Map();
  for (const g of Object.values(db.groups)) {
    codes.set(g.code, g.id);
    for (const id of [...Object.keys(g.members), ...Object.keys(g.pending)]) {
      if (!ug.has(id)) ug.set(id, new Set());
      ug.get(id).add(g.id);
    }
  }
  return { ug, codes };
}
function assertConsistent(s, step) {
  const { ug, codes } = expected(s.state.db);
  const norm = (m) => [...m].map(([k, v]) => [k, [...v].sort()]).sort();
  assert.deepEqual(norm(s.state.userGroups), norm(ug), `index des groupes après ${step}`);
  assert.deepEqual([...s.state.byCode].sort(), [...codes].sort(), `index des codes après ${step}`);
}

test('index cohérent après 300 opérations au hasard', async () => {
  const s = await startServer();
  try {
    // générateur pseudo-aléatoire reproductible
    let seed = 42;
    const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const users = [];
    for (let i = 0; i < 12; i++) users.push(await s.user('Util' + i));
    const groups = () => Object.values(s.state.db.groups);
    for (let step = 0; step < 300; step++) {
      const u = users[rnd(users.length)];
      const gs = groups();
      const g = gs.length ? gs[rnd(gs.length)] : null;
      const op = rnd(10);
      let name;
      if (op === 0 || !g) {
        name = 'create';
        await u.call('group:create', { name: 'G' + step });
      } else if (op <= 2) {
        name = 'join';
        await u.call('group:join', { code: g.code });
      } else if (op === 3) {
        name = 'approve';
        const admin = users.find((x) => g.members[x.init.me.id]?.role === 'admin');
        const p = Object.keys(g.pending)[0];
        if (admin && p) await admin.call('group:approve', { groupId: g.id, userId: p });
      } else if (op === 4) {
        name = 'reject';
        const admin = users.find((x) => g.members[x.init.me.id]?.role === 'admin');
        const p = Object.keys(g.pending)[0];
        if (admin && p) await admin.call('group:reject', { groupId: g.id, userId: p });
      } else if (op === 5) {
        name = 'kick';
        const admin = users.find((x) => g.members[x.init.me.id]?.role === 'admin');
        const m = Object.keys(g.members).find((id) => id !== admin?.init.me.id);
        if (admin && m) await admin.call('group:kick', { groupId: g.id, userId: m });
      } else if (op === 6) {
        name = 'leave';
        await u.call('group:leave', { groupId: g.id });
      } else if (op === 7) {
        name = 'code';
        const admin = users.find((x) => g.members[x.init.me.id]?.role === 'admin');
        if (admin) await admin.call('group:code', { groupId: g.id });
      } else if (op === 8) {
        name = 'delete';
        const admin = users.find((x) => g.members[x.init.me.id]?.role === 'admin');
        if (admin && rnd(3) === 0) await admin.call('group:delete', { groupId: g.id });
      } else {
        name = 'forget';
        if (rnd(4) === 0) {
          await u.call('forget');
          const i = users.indexOf(u);
          users[i] = await s.user('Util' + i + 'b');
        }
      }
      assertConsistent(s, `${step} (${name})`);
    }
    // les vues envoyées aux clients reposent sur l'index : chacun voit exactement ses groupes
    for (const u of users) {
      const c = await s.connect(u.token);
      const mine = groups().filter((g) => g.members[u.init.me.id] || g.pending[u.init.me.id]).map((g) => g.id).sort();
      assert.deepEqual(c.init.groups.map((g) => g.id).sort(), mine);
    }
    // suppression des groupes inactifs : index nettoyé
    s.clock.advance(40 * 86400000);
    users.forEach((u) => u.close());
    await new Promise((r) => setTimeout(r, 100));
    s.ticks.cleanup();
    assertConsistent(s, 'nettoyage des groupes inactifs');
    assert.equal(s.state.userGroups.size, 0);
  } finally {
    await s.stop();
  }
});

test('index reconstruit au redémarrage', async () => {
  const s = await startServer();
  const { admin, group } = await s.groupWithAdmin('Durable');
  const b = await s.user('Bea');
  await s.addMember(admin, group, b);
  await s.stop();
  const s2 = await startServer({ dataDir: s.dataDir });
  try {
    assertConsistent(s2, 'redémarrage');
    const c = await s2.user('Cleo');
    assert.deepEqual(await c.call('group:join', { code: group.code }), { ok: true, name: 'Durable' });
  } finally {
    await s2.stop();
  }
});
