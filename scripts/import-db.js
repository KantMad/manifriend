'use strict';
// Copie la base d'un hébergement Postgres (ex. Neon, version de test) vers le fichier du serveur.
//   SOURCE_DATABASE_URL=postgresql://… node scripts/import-db.js [/data/db.json] [--force]
// Sans --force, un fichier existant n'est jamais écrasé. Les positions et signalements n'existent
// dans aucune base : il n'y a rien d'autre à copier.
const fs = require('fs');
const path = require('path');
const { createPgStore } = require('../lib/store');

(async () => {
  const url = process.env.SOURCE_DATABASE_URL;
  const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(process.env.DATA_DIR || 'data', 'db.json');
  if (!url) throw new Error('SOURCE_DATABASE_URL manquant');
  if (fs.existsSync(out) && !process.argv.includes('--force')) throw new Error(`${out} existe déjà (ajouter --force pour l'écraser)`);
  const store = createPgStore(url, { log: { error() {} } });
  const data = await store.load();
  await store.close();
  if (!data) throw new Error('aucune donnée dans la base source');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out + '.tmp', JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(out + '.tmp', out);
  const n = (k) => Object.keys(data[k] || {}).length;
  console.log(`Base copiée : ${n('users')} comptes, ${n('groups')} groupes, ${n('events')} manifs`);
})().catch((e) => {
  console.error('Import impossible :', e.message);
  process.exit(1);
});
