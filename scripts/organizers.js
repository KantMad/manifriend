'use strict';
// Gestion des clés organisateur·ices (une par personne).
//   node scripts/organizers.js list
//   node scripts/organizers.js add "Camille"     -> affiche la nouvelle clé (une seule fois)
//   node scripts/organizers.js remove "Camille"  -> révocation immédiate, même pour les sessions ouvertes
// Avec Docker : docker compose exec app node scripts/organizers.js add "Camille"
const path = require('path');
const { createOrganizers } = require('../lib/organizers');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const orgs = createOrganizers({ dataDir });
const [cmd, name] = process.argv.slice(2);

try {
  if (cmd === 'add') {
    const key = orgs.add(name);
    console.log(`Clé de « ${name} » (à transmettre en main propre, elle ne sera plus affichée) :\n\n  ${key}\n`);
  } else if (cmd === 'remove') {
    console.log(orgs.remove(name) ? `Clé de « ${name} » révoquée.` : `Aucune clé pour « ${name} ».`);
  } else if (cmd === 'list') {
    const l = orgs.list();
    console.log(l.length ? l.map((k) => `- ${k.name} (créée le ${k.createdAt.slice(0, 10)})`).join('\n') : 'Aucune clé individuelle (seule ADMIN_KEY, si définie).');
  } else {
    console.log('Usage : node scripts/organizers.js list | add "Nom" | remove "Nom"');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
