'use strict';
// Repère les manifestations parmi les évènements d'un agenda militant (réunions, concerts… écartés).
// Limites de mots compatibles avec les accents (« démarches » ne contient pas le mot « marches »).

const word = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(${alts})(?![\\p{L}\\p{N}])`, 'iu');

const DEMO = word([
  'manif(?:estation)?s?', 'rassemblements?', 'marches?', 'cort[eè]ges?', 'd[ée]fil[ée]s?', 'gr[eè]ves?', 'mobilisations?',
  'piquets? de gr[eè]ve', 'die-in', 'cha[iî]nes? humaines?', 'sit-in', 'occupations?', 'blocages?', 'blocus', "journ[ée]e d'action",
  'appel [àa] manifester', 'convergence des luttes',
].join('|'));
// Les rassemblements non déclarés ne sont jamais importés (ils restent entre membres d'un groupe)
const UNDECLARED = word('sauvages?|non[- ]d[ée]clar[ée]e?s?|spontan[ée]e?s?');
// Évènements qui parlent de manif sans en être une
const NOT_DEMO = word([
  'r[ée]unions?', 'projections?', 'concerts?', 'ateliers?', 'formations?', 'permanences?', 'conf[ée]rences?', 'conf[ée]rence-d[ée]bat',
  'd[ée]bats?', 'repas', 'cantines?', 'soir[ée]es?', 'expos?', 'expositions?', 'caf[ée]s?', 'f[eê]tes?', 'festivals?', 'spectacles?',
  'lectures?', 'librairies?', 'cin[ée]s?', 'films?', 'bals?', 'r[ée]p[eè]tes?', 'r[ée]p[ée]titions?', 'cours', 'apéros?', 'brunchs?',
].join('|'));

function isDemo(title, ...more) {
  const t = String(title || '');
  const all = [t, ...more].filter(Boolean).join(' \n ');
  if (UNDECLARED.test(all)) return false;
  if (NOT_DEMO.test(t)) return false;
  return DEMO.test(t) || DEMO.test(all.slice(0, 600));
}

module.exports = { isDemo, word, DEMO, UNDECLARED, NOT_DEMO };
