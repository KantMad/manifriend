'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ical = require('../../lib/ical');
const { isDemo } = require('../../lib/importers/filter');
const { parseLocation, importDemosphere } = require('../../lib/importers/demosphere');
const { parseAgenda, headingDate, decodeEntities, importParisLuttes } = require('../../lib/importers/parisluttes');
const { parseGeom, importMobilizon } = require('../../lib/importers/mobilizon');
const { createGeocoder } = require('../../lib/geocode');
const { importAll, addDays } = require('../../lib/importers');
const U = require('../../lib/util');

const fx = (f) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');
const json = (obj, status = 200) => ({ ok: status < 400, status, headers: new Map(), json: async () => obj, text: async () => JSON.stringify(obj) });
const textRes = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) });

// Géocodeur factice : villes et lieux connus
const PLACES = {
  toulouse: { lat: 43.6045, lng: 1.444, city: 'Toulouse' },
  'place du capitole': { lat: 43.6044, lng: 1.4433, city: 'Toulouse' },
  paris: { lat: 48.8566, lng: 2.3522, city: 'Paris' },
  république: { lat: 48.8674, lng: 2.3631, city: 'Paris' },
  'château-d’eau': { lat: 48.8702, lng: 2.3573, city: 'Paris' },
};
function fakeGeocode(q, opts = {}) {
  const t = q.toLowerCase();
  const key = Object.keys(PLACES).sort((a, b) => b.length - a.length).find((k) => t.includes(k));
  if (!key) return Promise.resolve(null);
  if (opts.type === 'municipality' && !['toulouse', 'paris'].includes(key)) return Promise.resolve(null);
  return Promise.resolve({ ...PLACES[key], label: key, score: 0.9 });
}

// ---------- iCal ----------
test('iCal : lignes repliées, échappements, champs', () => {
  const evs = ical.parseICS('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Grande manif\\, unitaire\; \r\n vraiment\r\nLOCATION:Paris\\nRépublique\r\nDTSTART:20260115T130000Z\r\nGEO:48.86;2.36\r\nUID:x1\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].summary, 'Grande manif, unitaire; vraiment');
  assert.equal(evs[0].location, 'Paris\nRépublique');
  assert.deepEqual(evs[0].geo, { lat: 48.86, lng: 2.36 });
  assert.deepEqual(evs[0].start, { date: '2026-01-15', time: '14:00' }, 'hiver : UTC+1');
});

test('iCal : dates (été, journée entière, TZID, minuit, invalides)', () => {
  const p = (v, params = {}) => ical.parseDate({ value: v, params });
  assert.deepEqual(p('20260717T120000Z'), { date: '2026-07-17', time: '14:00' }, 'été : UTC+2');
  assert.deepEqual(p('20261017T223000Z'), { date: '2026-10-18', time: '00:30' }, 'changement de jour');
  assert.deepEqual(p('20261016T220000Z'), { date: '2026-10-17', time: '' }, 'minuit = heure inconnue');
  assert.deepEqual(p('20261018', { VALUE: 'DATE' }), { date: '2026-10-18', time: '' });
  assert.deepEqual(p('20261018T143000', { TZID: 'Europe/Paris' }), { date: '2026-10-18', time: '14:30' });
  assert.equal(p('n’importe quoi'), null);
  assert.equal(ical.parseDate(null), null);
  assert.deepEqual(ical.parseLine('DTSTART;TZID="Europe/Paris":20261018T1430'), { name: 'DTSTART', params: { TZID: 'Europe/Paris' }, value: '20261018T1430' });
  assert.equal(ical.parseLine('sans deux-points'), null);
});

test('iCal : GEO nul ignoré, évènement incomplet ignoré', () => {
  const evs = ical.parseICS(fx('demosphere.ics'));
  assert.equal(evs.length, 6);
  assert.equal(evs[0].geo, undefined, 'GEO:00;0 = pas de coordonnées');
  assert.deepEqual(evs[3].geo, { lat: 43.6045, lng: 1.444 });
  assert.deepEqual(ical.parseICS('BEGIN:VEVENT\nSUMMARY:x'), [], 'pas de END:VEVENT');
});

// ---------- Filtre ----------
test('filtre : manifs retenues, le reste écarté', () => {
  for (const t of ['Blocus des lycées', 'Manifestation pour la Palestine', 'Rassemblement devant la mairie', 'Grève générale', '17 octobre : Manifs au départ de République',
    'Marche pour le climat', 'Piquet de grève à la gare', 'Cortège de tête', 'Convergence des luttes - Rassemblement', 'MANIF NATIONALE'])
    assert.ok(isDemo(t), t);
  for (const t of ['Permanences en démarches de transition', 'Formation sécurité en manif', 'Répète avant la manif', 'Projection-débat sur les grèves',
    'Concert de soutien aux grévistes', 'Réunion publique', 'Atelier banderoles pour la manif', 'Rassemblement sauvage devant la préfecture',
    'Manif non déclarée', 'Cantine solidaire', ''])
    assert.equal(isDemo(t), false, t);
  assert.ok(isDemo('Appel du 18', 'manifestation à 14 h'), 'mot-clé dans la description');
  assert.equal(isDemo('Appel', 'rassemblement spontané'), false);
});

// ---------- Démosphère ----------
test('Démosphère : lecture du lieu', () => {
  assert.deepEqual(parseLocation('Paris 11e, \nCICP \n21 ter, rue Voltaire'), { city: 'Paris', postcode: '', district: '11e', lines: ['CICP', '21 ter, rue Voltaire'], generic: false });
  assert.equal(parseLocation('Toulouse 31200,\nPlace Micoulaud').postcode, '31200');
  assert.equal(parseLocation('Centre\nLa Station').generic, true);
  assert.equal(parseLocation('').generic, true);
});

test('Démosphère : import filtré, localisé, liens sûrs', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://toulouse.demosphere.net/events.ics');
    return textRes(fx('demosphere.ics'));
  };
  const res = await importDemosphere([{ id: 'toulouse', city: 'Toulouse' }], { today: '2026-10-17', until: '2026-11-16', geocode: fakeGeocode, fetchImpl });
  assert.deepEqual(res.sources, [{ name: 'Démosphère toulouse', ok: true, found: 6, matched: 3, kept: 2, unlocated: ['Journée d\'action nationale'] }]);
  const [a, b] = res.events;
  assert.equal(a.title, 'Manifestation pour les services publics, contre la réforme');
  assert.equal(a.date, '2026-10-17');
  assert.equal(a.time, '14:00');
  assert.equal(a.approx, false);
  assert.equal(a.lat, 43.6044, 'géocodé sur la place du Capitole');
  assert.equal(b.title, 'Rassemblement contre les expulsions');
  assert.equal(b.lat, 43.6045, 'coordonnées GEO du flux');
  // réunion, « partout », sauvage et passée : écartés
  assert.ok(!res.events.some((e) => /Réunion|Journée|sauvage|passée/.test(e.title)));
  // le lien javascript: sera neutralisé à l'enregistrement
  assert.equal(U.safeUrl(b.url), '');
});

test('Démosphère : erreur réseau signalée sans planter', async () => {
  const res = await importDemosphere(['inconnue'], { today: '2026-10-17', until: '2026-11-16', geocode: fakeGeocode, fetchImpl: async () => textRes('', 404) });
  assert.deepEqual(res.events, []);
  assert.equal(res.sources[0].ok, false);
  assert.match(res.sources[0].error, /404/);
});

// ---------- Paris-luttes.info ----------
test('Paris-luttes : lecture de l’agenda HTML', () => {
  const list = parseAgenda(fx('parisluttes-agenda.html'), 2026);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { date: '2026-10-17', time: '14:00', href: 'manif-au-depart-de-republique-21310', title: '17 octobre : Manifs au départ de République', lieu: 'République', address: [] });
  assert.deepEqual(list[1].address, ['9, rue François Debergue', '93100 MONTREUIL', 'M° 9 - Croix de Chavaux']);
  assert.equal(list[2].date, '2026-10-20');
  assert.equal(list[2].time, '', 'horaire non numérique');
  assert.equal(headingDate("Aujourd'hui (samedi 1er août)", 2026), '2026-08-01');
  assert.equal(headingDate('mardi 3 février', 2027), '2027-02-03');
  assert.equal(headingDate('Bientôt', 2026), null);
  assert.equal(decodeEntities('L&#8217;eau &amp; M&#176; &#x41;'), 'L’eau & M° A');
});

test('Paris-luttes : import (mois en cours et suivant)', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return textRes(url.includes('2026-10') ? fx('parisluttes-agenda.html') : '<main></main>');
  };
  const res = await importParisLuttes({ months: 2 }, { today: '2026-10-17', until: '2026-11-16', geocode: fakeGeocode, fetchImpl });
  assert.deepEqual(urls, ['https://paris-luttes.info/spip.php?page=agenda&date_agenda=2026-10-01', 'https://paris-luttes.info/spip.php?page=agenda&date_agenda=2026-11-01']);
  assert.equal(res.events.length, 2, 'la projection-débat est écartée');
  assert.equal(res.events[0].approx, true, 'seulement « République »');
  assert.equal(res.events[0].url, 'https://paris-luttes.info/manif-au-depart-de-republique-21310');
  assert.equal(res.events[1].approx, false, 'adresse complète');
  assert.match(res.events[1].sourceId, /greve-et-manifestation-21320\|2026-10-20/);
});

// ---------- Mobilizon ----------
test('Mobilizon : coordonnées « longitude;latitude »', () => {
  assert.deepEqual(parseGeom('7.745769;48.583464'), { lat: 48.583464, lng: 7.745769 });
  assert.equal(parseGeom('48.583464;7.745769'), null, 'ordre inversé jamais deviné');
  assert.equal(parseGeom('-3.7;40.4'), null, 'Madrid : hors zone');
  assert.equal(parseGeom(null), null);
  assert.equal(parseGeom('abc'), null);
});

test('Mobilizon : requête GraphQL avec variables et filtrage', async () => {
  const bodies = [];
  const el = (uuid, title, geom, beginsOn, tags = []) => ({ uuid, title, url: `https://mobilizon.fr/events/${uuid}`, beginsOn, physicalAddress: geom && { geom, description: 'Place Kléber', locality: 'Strasbourg', country: geom.startsWith('4.37') ? 'Belgique' : 'France' }, tags: tags.map((t) => ({ title: t })) });
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://mobilizon.fr/api');
    const body = JSON.parse(opts.body);
    bodies.push(body);
    assert.match(body.query, /\$term: String/);
    return json({ data: { searchEvents: { total: 4, elements: [
      el('a', 'Rassemblement pour la paix', '7.745769;48.583464', '2026-10-17T13:00:00Z'),
      el('a', 'Rassemblement pour la paix', '7.745769;48.583464', '2026-10-17T13:00:00Z'),
      el('b', 'Concert', '7.7;48.5', '2026-10-18T18:00:00Z', ['manifestation']),
      el('c', 'Marche', null, '2026-10-18T10:00:00Z'),
      el('d', 'Manifestation à Bruxelles', '4.37;50.82', '2026-10-18T10:00:00Z'),
    ] } } });
  };
  const res = await importMobilizon({ instances: ['https://mobilizon.fr'], terms: ['manifestation', 'grève'] }, { today: '2026-10-17', until: '2026-11-16', now: () => Date.parse('2026-10-17T08:00:00Z'), fetchImpl });
  assert.equal(bodies[0].variables.term, 'manifestation');
  assert.equal(bodies[0].variables.beginsOn, '2026-10-17T08:00:00.000Z');
  assert.equal(res.events.length, 1, 'doublon, concert, sans lieu et hors France écartés');
  assert.deepEqual({ ...res.events[0] }, { source: 'mobilizon', sourceId: 'a', title: 'Rassemblement pour la paix', date: '2026-10-17', time: '15:00', place: 'Place Kléber', city: 'Strasbourg', lat: 48.583464, lng: 7.745769, approx: false, url: 'https://mobilizon.fr/events/a' });
  assert.equal(res.sources[0].ok, true);
});

test('Mobilizon : erreur GraphQL remontée', async () => {
  const res = await importMobilizon({ instances: ['https://mobilizon.fr'], terms: ['x'] }, { today: '2026-10-17', until: '2026-11-16', now: Date.now, fetchImpl: async () => json({ errors: [{ message: 'champ inconnu' }] }) });
  assert.equal(res.sources[0].ok, false);
  assert.match(res.sources[0].error, /champ inconnu/);
});

// ---------- Géocodage ----------
test('géocodage : résultat proche retenu, lointain rejeté, repli et cache', async () => {
  const calls = [];
  const feature = (lng, lat, score = 0.9) => ({ geometry: { coordinates: [lng, lat] }, properties: { score, label: 'x', city: 'Strasbourg' } });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://data.geopf.fr') && url.includes('panne')) return json({}, 500);
    if (url.includes('Orl%C3%A9ans')) return json({ features: [feature(1.9, 47.9)] });
    return json({ features: [feature(1.9059, 47.9012), feature(7.7521, 48.5831)] });
  };
  const geocode = createGeocoder({ fetchImpl, delayMs: 0 });
  const strasbourg = { lat: 48.5734, lng: 7.7521 };
  const g = await geocode('Place de la République Strasbourg', { near: strasbourg, maxKm: 15 });
  assert.deepEqual([g.lat, g.lng], [48.5831, 7.7521], 'le résultat d’Orléans est rejeté');
  assert.match(calls[0], /lat=48.5734&lon=7.7521/);
  assert.equal(await geocode('Orléans', { near: strasbourg, maxKm: 15 }), null);
  const n = calls.length;
  await geocode('Place de la République Strasbourg', { near: strasbourg, maxKm: 15 });
  assert.equal(calls.length, n, 'mis en cache');
  await geocode('panne', {});
  assert.ok(calls.at(-1).startsWith('https://api-adresse.data.gouv.fr'), 'repli sur le second service');
  assert.equal(await geocode('ab'), null, 'requête trop courte');
});

test('géocodage : score trop faible ou hors France rejeté', async () => {
  const geocode = createGeocoder({ delayMs: 0, fetchImpl: async (u) => json({ features: [{ geometry: { coordinates: u.includes('madrid') ? [-3.7, 40.4] : [2.35, 48.85] }, properties: { score: u.includes('flou') ? 0.2 : 0.9 } }] }) });
  assert.equal(await geocode('lieu flou'), null);
  assert.equal(await geocode('madrid centre'), null);
  assert.ok(await geocode('paris centre'));
});

// ---------- Orchestration ----------
test('importAll : toutes les sources, fenêtre de 30 jours', async () => {
  assert.equal(addDays('2026-10-17', 30), '2026-11-16');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  const fetchImpl = async (url) => {
    if (url.includes('demosphere')) return textRes(fx('demosphere.ics'));
    if (url.includes('paris-luttes')) return textRes(fx('parisluttes-agenda.html'));
    if (url.includes('mobilizon')) return json({ data: { searchEvents: { elements: [] } } });
    throw new Error('inattendu ' + url);
  };
  const config = { daysAhead: 30, demosphere: [{ id: 'toulouse', city: 'Toulouse' }], mobilizon: { instances: ['https://mobilizon.fr'], terms: ['manifestation'] }, parisLuttes: { enabled: true, months: 1 } };
  const res = await importAll({ today: '2026-10-17', config, fetchImpl, geocode: fakeGeocode });
  assert.deepEqual(res.sources.map((x) => x.ok), [true, true, true]);
  assert.equal(res.events.length, 4);
  assert.ok(res.events.every((e) => U.EVENT_SOURCES.includes(e.source)));
});

test('config/sources.json valide', () => {
  const c = JSON.parse(fx('../../config/sources.json'));
  assert.ok(c.demosphere.length >= 15);
  assert.ok(c.demosphere.every((d) => /^[a-z0-9]+$/.test(d.id) && d.city));
  assert.ok(c.mobilizon.instances.every((u) => u.startsWith('https://')));
});
