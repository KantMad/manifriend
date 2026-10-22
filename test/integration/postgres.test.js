'use strict';
// Stockage Postgres (DATABASE_URL). Exécuté seulement si DATABASE_URL_TEST pointe vers une base jetable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, REPU } = require('../helpers');
const { createPgStore } = require('../../lib/store');

const url = process.env.DATABASE_URL_TEST;
const skip = !url && 'DATABASE_URL_TEST non défini';

test('Postgres : groupes et pseudos survivent au redémarrage ; positions et signalements jamais écrits', { skip }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  await pool.query('DROP TABLE IF EXISTS manif_friend_state');
  const s = await startServer({ databaseUrl: url });
  let s2;
  try {
    const { admin, group } = await s.groupWithAdmin('Durable', 'Alice');
    admin.socket.emit('pos', { ...REPU, mode: 'named' });
    await admin.call('report', { type: 'gaz', ...REPU });
    await s.stop();
    const raw = JSON.stringify((await pool.query('SELECT data FROM manif_friend_state')).rows);
    assert.ok(raw.includes('Durable'));
    assert.ok(!raw.includes(String(REPU.lat)), 'aucune position écrite');
    assert.ok(!raw.includes('gaz'), 'aucun signalement écrit');
    assert.ok(!raw.includes(admin.token), 'le jeton n’est jamais stocké');

    s2 = await startServer({ databaseUrl: url, dataDir: s.dataDir + '-vide' });
    const again = await s2.connect(admin.token);
    assert.equal(again.init.me.nickname, 'Alice');
    assert.ok(again.init.groups.some((g) => g.id === group.id), 'groupe rechargé depuis Postgres');
    assert.ok(s2.state.byCode.has(group.code), 'index reconstruit après chargement');
  } finally {
    if (s2) await s2.stop();
    await pool.query('DROP TABLE IF EXISTS manif_friend_state');
    await pool.end();
  }
});

test('Postgres : écritures rapprochées regroupées, la dernière version gagne', { skip }, async () => {
  const st = createPgStore(url);
  try {
    await Promise.all([1, 2, 3, 4, 5].map((n) => st.save(JSON.stringify({ n }))));
    assert.deepEqual(await st.load(), { n: 5 });
  } finally {
    await st.close();
  }
});

test('Postgres injoignable : le démarrage échoue clairement (pas de base vide qui écraserait les données)', { skip: false }, async () => {
  await assert.rejects(startServer({ databaseUrl: 'postgres://x:y@127.0.0.1:1/rien' }), /ECONNREFUSED|connect/);
});
