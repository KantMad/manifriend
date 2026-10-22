'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoutePlanner, thin, fromGeoJson } = require('../../lib/route');

const PLACES = {
  'place de la république': { lat: 48.8674, lng: 2.3631, label: 'Place de la République 75003 Paris' },
  'barbès': { lat: 48.8838, lng: 2.3497, label: 'Boulevard Barbès 75018 Paris' },
  'place de clichy': { lat: 48.8836, lng: 2.3275, label: 'Place de Clichy 75017 Paris' },
};
const geocode = async (q, opts) => {
  geocode.calls.push([q, opts]);
  if (opts.index) return [];
  const hit = PLACES[q.toLowerCase().replace(/, paris$/, '')];
  return hit ? [{ ...hit, score: 0.9, city: 'Paris' }] : [];
};
geocode.calls = [];
const json = (body, ok = true) => ({ ok, json: async () => body });

test('étapes géocodées puis reliées par l’itinéraire piéton de l’IGN', async () => {
  geocode.calls = [];
  const urls = [];
  const line = [[2.3631, 48.8674], [2.36, 48.87], [2.3497, 48.8838], [2.34, 48.884], [2.3275, 48.8836]];
  const plan = createRoutePlanner({ geocode, fetchImpl: async (u) => { urls.push(u); return json({ geometry: { type: 'LineString', coordinates: line } }); } });
  const r = await plan('Place de la République\nBarbès\nPlace de Clichy', { near: { lat: 48.86, lng: 2.35 } });
  assert.equal(r.via, 'ign');
  assert.deepEqual(r.points[0], [48.8674, 2.3631]);
  assert.equal(r.points.length, 5);
  assert.match(urls[0], /data\.geopf\.fr\/navigation\/itineraire/);
  assert.match(urls[0], /profile=pedestrian/);
  assert.match(urls[0], /intermediates=2\.3497%2C48\.8838/);
  // la première étape est cherchée près de la carte, les suivantes près de l'étape précédente
  assert.deepEqual(geocode.calls[0][1], { near: { lat: 48.86, lng: 2.35 }, maxKm: 30, all: true });
  assert.equal(geocode.calls[2][1].near.label, PLACES['place de la république'].label);
  assert.deepEqual(r.steps.map((s) => s.text), ['Place de la République', 'Barbès', 'Place de Clichy']);
});

test('secours : OSRM si l’IGN échoue, puis lignes droites si tout échoue', async () => {
  const line = [[2.3631, 48.8674], [2.3275, 48.8836]];
  const osrm = createRoutePlanner({ geocode, fetchImpl: async (u) => (/geopf/.test(u) ? json({}, false) : json({ routes: [{ geometry: { coordinates: line } }] })) });
  assert.equal((await osrm(['Place de la République', 'Place de Clichy'])).via, 'osrm');
  const down = createRoutePlanner({ geocode, fetchImpl: async () => { throw new Error('réseau'); } });
  const r = await down('Place de la République → Place de Clichy');
  assert.equal(r.via, 'droit');
  assert.deepEqual(r.points, [[48.8674, 2.3631], [48.8836, 2.3275]]);
});

test('erreurs claires : étapes manquantes, trop nombreuses ou introuvables', async () => {
  const plan = createRoutePlanner({ geocode, fetchImpl: async () => json({}) });
  assert.match((await plan('Place de la République')).error, /départ et une arrivée/);
  assert.match((await plan(Array.from({ length: 16 }, (_, i) => 'Rue ' + i))).error, /15 étapes/);
  const r = await plan('Place de la République\nNulle part du tout');
  assert.match(r.error, /introuvable.*Nulle part du tout/);
});

test('géométrie refusée si hors de France ou malformée ; tracé réduit à 500 points', () => {
  assert.equal(fromGeoJson([[2.3, 48.8], [-74, 40.7]]), null);
  assert.equal(fromGeoJson([[2.3, 48.8], 'x']), null);
  assert.equal(fromGeoJson(null), null);
  const long = Array.from({ length: 2000 }, (_, i) => [i, i]);
  const t = thin(long);
  assert.equal(t.length, 500);
  assert.deepEqual(t[0], [0, 0]);
  assert.deepEqual(t[499], [1999, 1999]);
});

test('le lieu le plus proche l’emporte à score voisin : République à Paris, pas à Montreuil ; gare via les lieux nommés', async () => {
  const geo = async (q, opts) => {
    if (q === 'Place de la République' && !opts.index) {
      return [{ lat: 48.8606, lng: 2.4400, label: 'Place de la République 93100 Montreuil', city: 'Montreuil', score: 0.95 },
        { lat: 48.8674, lng: 2.3631, label: 'Place de la République 75003 Paris', city: 'Paris', score: 0.93 }];
    }
    if (q === 'Gare du Nord' && !opts.index) return [{ lat: 48.8295, lng: 2.3780, label: 'Port de la Gare 75013 Paris', city: 'Paris', score: 0.6 }];
    if (q === 'Gare du Nord' && opts.index === 'poi') return [{ lat: 48.8809, lng: 2.3553, label: 'Gare du Nord', city: 'Paris', score: 0.7 }];
    return [];
  };
  const plan = createRoutePlanner({ geocode: geo, fetchImpl: async () => { throw new Error('hors ligne'); } });
  const r = await plan('Place de la République\nGare du Nord', { near: { lat: 48.8662, lng: 2.3556 } });
  assert.deepEqual(r.steps.map((x) => x.label), ['Place de la République 75003 Paris', 'Gare du Nord']);
});
