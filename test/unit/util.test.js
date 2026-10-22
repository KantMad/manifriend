'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../lib/util');

test('own : ignore la chaîne de prototypes', () => {
  const o = { a: 1 };
  assert.equal(U.own(o, 'a'), 1);
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(U.own(o, k), undefined, k);
  assert.equal(U.own(o, 1), undefined);
  assert.equal(U.own(o, { toString: () => 'a' }), undefined);
  assert.equal(U.own(null, 'a'), undefined);
});

test('cleanText : types, longueur, caractères de contrôle et invisibles', () => {
  assert.equal(U.cleanText(42, 10), '');
  assert.equal(U.cleanText(null, 10), '');
  assert.equal(U.cleanText({}, 10), '');
  assert.equal(U.cleanText('  Bonjour   tout\tle\nmonde ', 100), 'Bonjour tout le monde');
  assert.equal(U.cleanText('abcdef', 3), 'abc');
  assert.equal(U.cleanText('a\u0000b\u001fc\u007fd', 20), 'a b c d');
  // caractères bidirectionnels / largeur nulle (usurpation de texte)
  assert.equal(U.cleanText('ad‮min​', 20), 'ad min');
  // le HTML n'est pas « nettoyé » côté serveur : le client l'affiche toujours en texte
  assert.equal(U.cleanText('<b>x</b>', 20), '<b>x</b>');
});

test('validLatLng : France métropolitaine et Corse acceptées, le reste refusé', () => {
  for (const [a, b] of [[45.76, 4.83], [43.3, 5.4], [41.92, 8.74], [50.63, 3.06], [48.39, -4.49]]) assert.ok(U.validLatLng(a, b), `${a},${b}`);
  assert.ok(U.validLatLng(48.8566, 2.3522));
  assert.ok(U.validLatLng(48.7, 2.1));
  assert.ok(U.validLatLng(49.0, 2.6));
  for (const [a, b] of [[40.42, -3.7], [51.5, -0.12], [48.85, 12.5], [35, 2], [NaN, 2.35], [Infinity, 2.35], ['48.85', 2.35], [null, null], [undefined, 2.3]])
    assert.equal(U.validLatLng(a, b), false, `${a},${b}`);
});

test('isValidTime / isValidDate', () => {
  for (const t of ['00:00', '09:05', '14:30', '23:59']) assert.ok(U.isValidTime(t), t);
  for (const t of ['24:00', '9:05', '12:60', '12h30', '', null, 1430, '12:30:00']) assert.equal(U.isValidTime(t), false, String(t));
  assert.ok(U.isValidDate('2026-10-17'));
  for (const d of ['2026-13-01', '17/10/2026', '2026-10-1', '', 'abcd-ef-gh', null]) assert.equal(U.isValidDate(d), false, String(d));
});

test('validHeading', () => {
  assert.equal(U.validHeading(0), 0);
  assert.equal(U.validHeading(135.4), 135);
  assert.equal(U.validHeading(359.6), 0);
  for (const h of [-1, 360, NaN, '90', null, undefined]) assert.equal(U.validHeading(h), null, String(h));
});

test('createRateLimiter : fenêtre glissante et purge', () => {
  let t = 0;
  const r = U.createRateLimiter(() => t);
  for (let i = 0; i < 3; i++) assert.equal(r.limited('k', 3, 1000), false);
  assert.equal(r.limited('k', 3, 1000), true);
  assert.equal(r.limited('autre', 3, 1000), false, 'clés indépendantes');
  t = 1001;
  assert.equal(r.limited('k', 3, 1000), false, 'la fenêtre a glissé');
  t = 10 * 3600000;
  r.prune();
  assert.equal(r.size, 0);
});

test('jetons et identifiants', () => {
  assert.ok(U.validToken('a'.repeat(20)));
  for (const t of ['a'.repeat(19), 'a'.repeat(201), 123, null, undefined, {}, ['a'.repeat(30)]]) assert.equal(U.validToken(t), false);
  const id = U.userIdFromToken('mon-jeton');
  assert.match(id, /^[0-9a-f]{20}$/);
  assert.equal(U.userIdFromToken('mon-jeton'), id, 'stable');
  assert.notEqual(U.userIdFromToken('autre-jeton'), id);
  assert.ok(!id.includes('mon-jeton'));
});

test('anonId : stable dans un groupe, différent entre groupes et sans le secret', () => {
  const a1 = U.anonId('s', 'user', 'g1');
  assert.equal(U.anonId('s', 'user', 'g1'), a1);
  assert.notEqual(U.anonId('s', 'user', 'g2'), a1, 'non reliable entre groupes');
  assert.notEqual(U.anonId('autre-secret', 'user', 'g1'), a1);
  assert.ok(!a1.includes('user'));
});

test('inviteCode : 8 caractères sans ambiguïté, aléatoires', () => {
  const codes = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = U.inviteCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
    codes.add(c);
  }
  assert.equal(codes.size, 2000);
  assert.ok(!/[01IO]/.test(U.CODE_ALPHABET));
  assert.equal(U.normalizeCode(' ab-cd ef 12 '), 'ABCDEF12');
  assert.equal(U.normalizeCode({}), '');
});

test('checkKey : clé vide = désactivé, comparaison exacte', () => {
  assert.equal(U.checkKey('', ''), false);
  assert.equal(U.checkKey('', 'x'), false);
  assert.equal(U.checkKey('secret', 'secret'), true);
  assert.equal(U.checkKey('secret', 'Secret'), false);
  assert.equal(U.checkKey('secret', 'secret '), false);
  assert.equal(U.checkKey('secret', undefined), false);
  assert.equal(U.checkKey('secret', ['secret']), false);
});

test('parisDate / dayOf : fuseau Europe/Paris', () => {
  // 23h30 UTC le 17 = 01h30 le 18 à Paris (heure d'été)
  assert.equal(U.parisDate(Date.parse('2026-07-17T23:30:00Z')), '2026-07-18');
  assert.equal(U.dayOf(Date.parse('2026-07-17T23:30:00Z')), '2026-07-17');
});

test('densityCells : agrégation et seuil d’anonymat', () => {
  const p = (lat, lng) => ({ lat, lng });
  const pts = [p(48.8601, 2.3501), p(48.8602, 2.3502), p(48.8603, 2.3503), p(48.8701, 2.3601), p(48.8702, 2.3602)];
  const cells = U.densityCells(pts);
  assert.equal(cells.length, 1, 'la cellule de 2 personnes est masquée');
  assert.equal(cells[0].n, 3);
  // le centre de cellule ne révèle pas les positions exactes
  assert.ok(!pts.some((x) => x.lat === cells[0].lat && x.lng === cells[0].lng));
  assert.deepEqual(U.densityCells([]), []);
  assert.equal(U.densityCells(pts, { min: 2 }).length, 2);
});

test('sanitizeRoutePoints', () => {
  const ok = U.sanitizeRoutePoints([[48.8674, 2.3631], ['48.8484', '2.3958']]);
  assert.deepEqual(ok, [[48.8674, 2.3631], [48.8484, 2.3958]]);
  assert.equal(U.sanitizeRoutePoints([[48.86, 2.36]]), null, 'un seul point');
  assert.equal(U.sanitizeRoutePoints('x'), null);
  assert.equal(U.sanitizeRoutePoints([[48.86, 2.36], [40.4, -3.7]]), null, 'hors France');
  assert.equal(U.sanitizeRoutePoints([[48.86, 2.36], { 0: 48.86, 1: 2.36 }]), null);
  assert.equal(U.sanitizeRoutePoints(Array(501).fill([48.86, 2.36])), null, 'trop de points');
  assert.deepEqual(U.sanitizeRoutePoints([[48.812345678, 2.3], [48.8, 2.4]])[0], [48.812346, 2.3]);
});

test('REPORT_TYPES : durées de vie cohérentes', () => {
  for (const [k, v] of Object.entries(U.REPORT_TYPES)) assert.ok(v.ttl >= 10 && v.ttl <= 120, k);
  assert.deepEqual(Object.keys(U.REPORT_TYPES).sort(), ['blocage', 'calme', 'cortege', 'gaz', 'info', 'medic', 'nasse', 'violence']);
});
