'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers');

test('pages juridiques servies en HTML, sous la CSP stricte, avec les valeurs configurées', async () => {
  const s = await startServer({ legal: { editeur: 'Collectif Test', contact: 'contact@exemple.fr', hebergeur: 'Render', test: true } });
  try {
    for (const route of ['/confidentialite', '/mentions-legales']) {
      const r = await fetch(s.url + route);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      const t = await r.text();
      assert.match(t, /Collectif Test/);
      assert.match(t, /contact@exemple\.fr/);
      assert.match(t, /Version de test/);
      assert.doesNotMatch(t, /\{\{/);
    }
    const css = await fetch(s.url + '/legal.css');
    assert.equal(css.status, 200);
  } finally {
    await s.stop();
  }
});
