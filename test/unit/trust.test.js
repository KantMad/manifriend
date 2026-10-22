'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { autoPublishDecision } = require('../../lib/importers/trust');

const policy = { demosphere: true, 'paris-luttes': true, mobilizon: false, maxDays: 14 };
const base = { source: 'demosphere', title: 'Manifestation pour les salaires', date: '2026-10-20', time: '14:00', place: 'Place du Capitole', approx: false };
const decide = (over) => autoPublishDecision({ ...base, ...over }, { policy, today: '2026-10-17' });

test('manif claire d’un agenda modéré, lieu précis, heure connue : publiée automatiquement', () => {
  assert.equal(decide({}).auto, true);
  assert.equal(decide({ source: 'paris-luttes', title: 'Rassemblement devant la préfecture' }).auto, true);
  assert.equal(decide({ title: 'Marche pour le climat' }).auto, true);
});

test('validation à la main : source ouverte, lieu approximatif, heure inconnue, titre flou, trop lointaine', () => {
  assert.match(decide({ source: 'mobilizon' }).why, /source/);
  assert.match(decide({ approx: true }).why, /approximatif/);
  assert.match(decide({ time: '' }).why, /heure/);
  assert.match(decide({ title: 'Grève générale' }).why, /titre/);
  assert.match(decide({ date: '2026-11-15' }).why, /lointaine/);
  assert.equal(autoPublishDecision(base, { policy: undefined, today: '2026-10-17' }).auto, false, 'sans configuration : rien d’automatique');
});

test('blocages, occupations et actions sensibles : jamais publiés sans validation', () => {
  for (const title of ['Manifestation et blocage du périphérique', 'Rassemblement puis occupation de la fac', 'Marche vers la ZAD', 'Manif : bloquons tout'])
    assert.equal(decide({ title }).auto, false, title);
  assert.equal(decide({ note: 'action directe prévue' }).auto, false);
});
