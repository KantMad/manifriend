'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { legalConfig, renderLegal, loadTemplates } = require('../../lib/legal');

const tpls = loadTemplates();

test('variables LEGAL_* lues depuis l’environnement', () => {
  const c = legalConfig({ LEGAL_EDITEUR: 'Collectif X', LEGAL_CONTACT: 'a@b.fr', LEGAL_TEST: '1' });
  assert.equal(c.editeur, 'Collectif X');
  assert.equal(c.contact, 'a@b.fr');
  assert.equal(c.test, true);
  assert.equal(legalConfig({}).test, false);
});

test('tous les marqueurs sont remplacés, les champs absents signalés « à compléter »', () => {
  for (const tpl of Object.values(tpls)) {
    const html = renderLegal(tpl, legalConfig({}), { selfHostedMap: false, version: '1.0.0' });
    assert.doesNotMatch(html, /\{\{/);
    assert.match(html, /class="a-completer"/);
    assert.doesNotMatch(html, /<script/i, 'pages sans script');
  }
});

test('valeurs échappées : pas d’injection HTML par la configuration', () => {
  const cfg = legalConfig({ LEGAL_EDITEUR: '<img src=x onerror=alert(1)>', LEGAL_CONTACT: '"x" & y' });
  const html = renderLegal(tpls['/mentions-legales'], cfg, { selfHostedMap: true, version: '1' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;x&quot; &amp; y/);
});

test('carte : OSM nommée seulement si la carte n’est pas auto-hébergée ; avertissement de test', () => {
  const tpl = tpls['/confidentialite'];
  const osm = renderLegal(tpl, legalConfig({ LEGAL_TEST: '1' }), { selfHostedMap: false, version: '1' });
  const own = renderLegal(tpl, legalConfig({}), { selfHostedMap: true, version: '1' });
  assert.match(osm, /fondation OpenStreetMap/);
  assert.doesNotMatch(own, /fondation OpenStreetMap/);
  const partial = renderLegal(tpl, legalConfig({}), { selfHostedMap: true, partialMap: true, version: '1' });
  assert.match(partial, /en dehors de la zone couverte/);
  assert.match(osm, /Version de test/);
  assert.doesNotMatch(own, /Version de test/);
});

test('hébergeur de la base nommé seulement s’il est configuré', () => {
  const tpl = tpls['/confidentialite'];
  assert.match(renderLegal(tpl, legalConfig({ LEGAL_BASE: 'Neon <Francfort>' }), { selfHostedMap: true, version: '1' }), /Neon &lt;Francfort&gt;/);
  assert.doesNotMatch(renderLegal(tpl, legalConfig({}), { selfHostedMap: true, version: '1' }), /base de données<\/strong>/);
});
