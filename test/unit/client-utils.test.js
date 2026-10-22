'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MF = require('../../public/utils.js');

test('ago', () => {
  const now = 1_000_000_000;
  assert.equal(MF.ago(now, now), 'il y a 0 s');
  assert.equal(MF.ago(now - 45_000, now), 'il y a 45 s');
  assert.equal(MF.ago(now - 5 * 60_000, now), 'il y a 5 min');
  assert.equal(MF.ago(now - 3 * 3600_000, now), 'il y a 3 h');
  assert.equal(MF.ago(now + 10_000, now), 'il y a 0 s', 'horloge en avance');
});

test('dist : distances connues à Paris', () => {
  const repu = { lat: 48.8674, lng: 2.3631 };
  const nation = { lat: 48.8484, lng: 2.3958 };
  const d = MF.dist(repu, nation);
  assert.ok(d > 3000 && d < 3200, `${d}`); // ~3,1 km
  assert.equal(MF.dist(repu, repu), 0);
  assert.ok(Math.abs(MF.dist(repu, nation) - MF.dist(nation, repu)) < 1e-6);
});

test('fmtDist', () => {
  assert.equal(MF.fmtDist(0), '0 m');
  assert.equal(MF.fmtDist(94), '90 m');
  assert.equal(MF.fmtDist(999), '1000 m');
  assert.equal(MF.fmtDist(1000), '1.0 km');
  assert.equal(MF.fmtDist(3149), '3.1 km');
});

test('colorFor : stable et dans la palette', () => {
  assert.equal(MF.colorFor('abc'), MF.colorFor('abc'));
  for (const id of ['a', 'groupe', 'xyz123', '']) assert.ok(MF.GROUP_COLORS.includes(MF.colorFor(id)));
});

test('headingLabel', () => {
  assert.equal(MF.headingLabel(0), 'N');
  assert.equal(MF.headingLabel(90), 'E');
  assert.equal(MF.headingLabel(135), 'SE');
  assert.equal(MF.headingLabel(270), 'O');
  assert.equal(MF.headingLabel(350), 'N');
  assert.equal(MF.headingLabel(-90), 'O');
});

test('initials', () => {
  assert.equal(MF.initials('alice'), 'AL');
  assert.equal(MF.initials(' Zoé '), 'ZO');
  assert.equal(MF.initials('😀x'), '😀X', 'emoji non coupé en deux');
  assert.equal(MF.initials(null), '?');
  assert.equal(MF.initials('   '), '?');
});

test('makeToken : 32 caractères base64url', () => {
  const crypto = require('crypto');
  const t = MF.makeToken((b) => crypto.randomFillSync(b));
  assert.match(t, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(MF.makeToken((b) => crypto.randomFillSync(b)), t);
});

test('liens d’invitation', () => {
  assert.equal(MF.inviteLink('https://manif.fr', 'AB12CD34'), 'https://manif.fr/?join=AB12CD34');
  assert.equal(MF.joinCodeFromSearch('?join=ab12cd34'), 'AB12CD34');
  assert.equal(MF.joinCodeFromSearch('?join=<script>'), 'SCRIPT');
  assert.equal(MF.joinCodeFromSearch('?join='), null);
  assert.equal(MF.joinCodeFromSearch('?x=1'), null);
  assert.equal(MF.joinCodeFromSearch('?join=%22%3E%3C'), null);
});
