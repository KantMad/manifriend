'use strict';
// Lance l'import des manifs à la main. --dry-run : affiche ce qui serait importé, sans rien enregistrer.
// (En production, le serveur importe tout seul toutes les 2 h : 🤖 = publiée automatiquement, sinon « à valider ».)
const { importAll } = require('../lib/importers');
const { parisDate } = require('../lib/util');

(async () => {
  const res = await importAll({ today: parisDate(Date.now()) });
  for (const s of res.sources) console.log(s.ok ? `✓ ${s.name} : ${s.found} évènements lus, ${s.matched} manifs repérées, ${s.kept} localisées${s.unlocated && s.unlocated.length ? ' — non localisées : ' + s.unlocated.join(' | ') : ''}` : `✗ ${s.name} : ${s.error}`);
  console.log(`\n${res.events.length} manifs trouvées, dont ${res.events.filter((e) => e.auto).length} publiées automatiquement (🤖) :`);
  for (const e of res.events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)))
    console.log(`${e.auto ? '🤖' : '- '} ${e.date} ${e.time || '--:--'} | ${e.city} | ${e.title} | ${e.place.slice(0, 80)} | ${e.lat.toFixed(4)},${e.lng.toFixed(4)}${e.approx ? ' (approx.)' : ''} | ${e.url}${e.auto ? '' : ' | à valider : ' + e.why}`);
  if (!process.argv.includes('--dry-run')) console.log('\n(Pour enregistrer, laisser le serveur faire l’import : il est automatique.)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
