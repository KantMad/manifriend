'use strict';
// Vérifie le tracé automatique avec les vrais services (géocodage et itinéraire de l'IGN, OSRM en secours).
// Usage : node scripts/probe-route.js ["Étape 1\nÉtape 2…"]
const { createRoutePlanner } = require('../lib/route');
const { createGeocoder } = require('../lib/geocode');

const LISTS = process.argv[2] ? [process.argv[2]] : [
  'Place de la République\nBoulevard de Magenta\nBarbès\nBoulevard de Rochechouart\nPlace Pigalle\nPlace de Clichy',
  'République\nGare du Nord\nBarbès\nPigalle\nClichy',
  'Place de la République\nNation',
];
const say = (m) => console.log(process.env.GITHUB_ACTIONS ? '::notice::' + m : m);

const fail = (m) => console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + m);

(async () => {
  const plan = createRoutePlanner({ geocode: createGeocoder() });
  let ok = true;
  for (const steps of LISTS) {
    const r = await plan(steps, { near: { lat: 48.8566, lng: 2.3522 } });
    if (r.error) { fail('Tracé : ' + r.error); ok = false; continue; }
    say(`Tracé via ${r.via} : ${r.points.length} points ; étapes : ${r.steps.map((s) => `${s.text} = ${s.label}`).join(' | ')}`);
    if (r.via === 'droit') { fail('Aucun service d’itinéraire joignable'); ok = false; }
  }
  process.exit(ok ? 0 : 1);
})();
