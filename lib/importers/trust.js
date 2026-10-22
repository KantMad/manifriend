'use strict';
// Publication automatique des manifs importées : seulement quand tout indique une manif publique fiable.
// Le reste attend la validation d'un·e organisateur·ice, qui peut aussi retirer à tout moment une manif publiée.

const { word } = require('./filter');

// Le titre doit annoncer clairement un rassemblement public
const STRONG = word([
  'manif(?:estation)?s?', 'rassemblements?', 'marches?', 'cort[eè]ges?', 'd[ée]fil[ée]s?', 'cha[iî]nes? humaines?',
  'die-in', 'sit-in', "journ[ée]e d'action", 'mobilisations?',
].join('|'));
// Actions où publier le lieu pourrait exposer les participant·es : toujours validées à la main
const RISKY = word([
  'blocages?', 'bloquons', 'blocus', 'occupations?', 'occupons', 'piquets? de gr[eè]ve', 'actions? directes?',
  'd[ée]sob[ée]issance', 'zad', 'squats?', 'r[ée]quisitions?', 'sabotages?', 'clandestine?s?', 'secr[eè]te?s?',
].join('|'));

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// policy : { demosphere: true, 'paris-luttes': true, mobilizon: false, maxDays: 14 }
function autoPublishDecision(ev, { policy = {}, today }) {
  if (policy[ev.source] !== true) return { auto: false, why: 'source à valider à la main' };
  if (ev.approx) return { auto: false, why: 'lieu approximatif' };
  if (!ev.time) return { auto: false, why: 'heure inconnue' };
  const text = [ev.title, ev.note, ev.place].filter(Boolean).join(' \n ');
  if (RISKY.test(text)) return { auto: false, why: 'action à vérifier (blocage, occupation…)' };
  if (!STRONG.test(String(ev.title || ''))) return { auto: false, why: 'titre peu clair' };
  if (today && ev.date > addDays(today, policy.maxDays || 14)) return { auto: false, why: 'trop lointaine' };
  return { auto: true, why: 'publiée automatiquement' };
}

module.exports = { autoPublishDecision, STRONG, RISKY };
