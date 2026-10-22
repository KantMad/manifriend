'use strict';
// Stockage durable de la base (groupes, comptes, manifs) : fichier JSON par défaut, ou Postgres si
// DATABASE_URL est défini (hébergement sans disque, ex. Render + Neon). Toute la base tient dans un
// seul document JSON : les positions et signalements, eux, ne sont jamais écrits nulle part.

const fs = require('fs');
const path = require('path');

function createFileStore(dir) {
  const file = path.join(dir, 'db.json');
  return {
    kind: 'fichier',
    async load() {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    loadSync() {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    save(json) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);
      return Promise.resolve();
    },
    async close() {},
  };
}

// sslmode=require (adresse donnée par Neon) : on vérifie aussi le certificat (verify-full), ce que pg
// fait déjà mais en affichant un avertissement à chaque démarrage
const strictSsl = (url) => String(url).replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, '$1verify-full');

function createPgStore(url, { log = console, Pool = require('pg').Pool } = {}) {
  const pool = new Pool({ connectionString: strictSsl(url), max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => log.error('Base Postgres :', e.message));
  let ready = null;
  const init = () => (ready ||= pool.query(
    'CREATE TABLE IF NOT EXISTS manif_friend_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
  ).catch((e) => { ready = null; throw e; }));
  // Écritures en série : la dernière version gagne toujours, aucune écriture ne passe devant une plus récente
  let chain = Promise.resolve();
  let pending = null;
  return {
    kind: 'postgres',
    async load() {
      await init();
      const r = await pool.query('SELECT data FROM manif_friend_state WHERE id = 1');
      return r.rows[0] ? r.rows[0].data : null;
    },
    save(json) {
      const first = pending === null;
      pending = json;
      if (!first) return chain; // une écriture attend déjà : elle prendra cette version
      chain = chain.then(async () => {
        const data = pending;
        pending = null;
        await init();
        await pool.query(
          'INSERT INTO manif_friend_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
          [data]
        );
      }).catch((e) => log.error('Sauvegarde Postgres impossible :', e.message));
      return chain;
    },
    async close() {
      await chain;
      await pool.end();
    },
  };
}

module.exports = { createFileStore, createPgStore, strictSsl };
