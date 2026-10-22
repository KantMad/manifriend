'use strict';
// Tests dans un vrai navigateur (Chromium via Playwright). Ignorés si Playwright n'est pas disponible.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, REPU } = require('../helpers');

// Les requêtes faites par le service worker passent aussi par le simulateur de tuiles
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const XSS = '<img src=x onerror="window.__xss=1">';
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

let s;
let browser;
const skip = !chromium && 'Playwright non installé';

before(async () => {
  if (skip) return;
  s = await startServer({ timers: true });
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (s) await s.stop();
});

// account : pseudo d'un compte créé d'avance (connecté sur la page) ; sinon simple visiteur
async function page({ consent = true, account, ...opts } = {}) {
  let session = null;
  if (account) {
    const c = await s.user(account);
    session = c.token;
    c.socket.close();
  }
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: REPU.lat, longitude: REPU.lng },
    permissions: ['geolocation'],
    serviceWorkers: 'block', // sinon le service worker contourne le simulateur de tuiles
    reducedMotion: 'reduce', // pas d'animation : les mesures de position ne dépendent pas de la vitesse de la machine
    ...opts,
  });
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
  const p = await ctx.newPage();
  p.errors = [];
  p.csp = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/favicon|tile/.test(m.text()) && p.errors.push(m.text()));
  // Consentement déjà donné, sauf pour le test qui le vérifie
  if (consent) await p.addInitScript(() => localStorage.getItem('mf_consent') || localStorage.setItem('mf_consent', JSON.stringify({ v: 2, at: 0 })));
  if (session) await p.addInitScript((t) => localStorage.getItem('mf_token') || localStorage.setItem('mf_token', JSON.stringify(t)), session);
  await p.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  await p.goto(s.url + '/');
  await p.waitForSelector('#conn.on');
  return p;
}
const closeSheet = (p) => p.click('.sheet-close >> visible=true');

test('premier lancement : visite guidée, aucun compte demandé, aucune erreur', { skip }, async () => {
  const p = await page();
  await p.waitForSelector('#tour:not([hidden])');
  assert.match(await p.textContent('.tour-card'), /ni e-mail, ni numéro/);
  assert.equal(await p.isVisible('#auth[open]'), false, 'aucun compte demandé pour regarder');
  await p.click('#tour-skip');
  assert.equal(await p.isVisible('#tour'), false);
  await p.reload();
  await p.waitForSelector('#conn.on');
  await p.waitForTimeout(300);
  assert.equal(await p.isVisible('#tour'), false, 'la visite ne revient pas toute seule');
  // on peut la relancer depuis Infos
  await p.click('#btn-info');
  await p.click('#open-tour');
  await p.waitForSelector('#tour:not([hidden])');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(await p.evaluate(() => window.__csp), [], 'aucune violation CSP');
  await p.context().close();
});

test('consentement : demandé avant tout partage, un refus ne partage rien', { skip }, async () => {
  const p = await page({ consent: false });
  await p.click('#tour-skip');
  await p.click('#share-pill');
  await p.click('input[name=mode][value=anon]');
  await p.waitForSelector('#consent[open]');
  assert.match(await p.textContent('#consent'), /opinions politiques/);
  await p.click('#consent button[value=cancel]');
  // refus : le partage reste coupé (remis à « off » après la fermeture de la fenêtre)
  await p.waitForFunction(() => document.querySelector('input[name=mode][value=off]').checked);
  assert.match(await p.textContent('#share-pill'), /off/);
  assert.equal(await p.evaluate(() => localStorage.getItem('mf_consent')), null);
  // création de groupe : accord demandé avant le pseudo
  await closeSheet(p);
  await p.click('#btn-groups');
  await p.click('summary >> text=Créer');
  await p.fill('#create-name', 'Consentis');
  await p.click('#create-form button');
  await p.waitForSelector('#consent[open]');
  await p.click('#consent-ok');
  // puis création du compte : pseudo + mot de passe, code de secours à noter
  await p.waitForSelector('#auth[open]');
  assert.match(await p.textContent('#auth-title'), /Créer un compte/);
  assert.equal(JSON.parse(await p.evaluate(() => localStorage.getItem('mf_consent'))).v, 2);
  await p.fill('#auth-name', 'Consentant');
  await p.fill('#auth-pass', 'court');
  await p.click('#auth-ok');
  await p.waitForFunction(() => /8 caractères/.test(document.getElementById('auth-error').textContent));
  await p.fill('#auth-pass', 'un-bon-mot-de-passe');
  await p.click('#auth-ok');
  await p.waitForSelector('#recovery[open]');
  assert.match(await p.textContent('#recovery-code'), /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(await p.isDisabled('#recovery-ok'), true, 'pas de fermeture avant d’avoir noté le code');
  await p.check('#recovery-done');
  await p.click('#recovery-ok');
  // l'action interrompue reprend : le groupe est créé
  await p.waitForSelector('.group h4');
  assert.equal(await p.textContent('.group h4'), 'Consentis');
  assert.match(await p.textContent('#my-nick'), /Consentant/);
  assert.ok(!(await p.evaluate(() => JSON.stringify(localStorage))).includes('un-bon-mot-de-passe'), 'mot de passe jamais gardé sur l’appareil');
  // pages juridiques accessibles depuis Infos, sans script
  const r = await p.request.get(s.url + '/confidentialite');
  assert.equal(r.status(), 200);
  assert.doesNotMatch(await r.text(), /<script|\{\{/);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('visite guidée : chaque bouton est mis en lumière et expliqué, sur toutes les tailles d’écran', { skip }, async () => {
  for (const [w, hgt] of [[320, 568], [390, 844], [820, 1180], [1440, 900]]) {
    const p = await page({ viewport: { width: w, height: hgt } });
    await p.waitForSelector('#tour:not([hidden])');
    const total = Number((await p.textContent('#tour-step')).match(/sur (\d+)/)[1]);
    assert.ok(total >= 12, 'au moins 12 étapes');
    const titles = new Set();
    for (let i = 0; i < total; i++) {
      await p.waitForTimeout(350); // transition de la mise en lumière
      const m = await p.evaluate(() => {
        const card = document.querySelector('.tour-card').getBoundingClientRect();
        const hole = document.querySelector('.tour-hole');
        const hr = hole.getBoundingClientRect();
        return {
          title: document.getElementById('tour-title').textContent,
          text: document.getElementById('tour-text').textContent,
          goal: document.getElementById('tour-goal').textContent,
          step: document.getElementById('tour-step').textContent,
          noHole: hole.classList.contains('none'),
          card: { l: card.left, t: card.top, r: card.right, b: card.bottom },
          hole: { l: hr.left, t: hr.top, r: hr.right, b: hr.bottom },
          W: innerWidth, H: innerHeight,
        };
      });
      const tag = `${w}px étape ${i + 1} « ${m.title} »`;
      assert.ok(m.title && m.text.length > 40, `${tag} : explication`);
      if (i > 0 && i < total - 1) assert.match(m.goal, /À quoi ça sert/, `${tag} : but`);
      titles.add(m.title);
      assert.ok(m.card.l >= 0 && m.card.t >= 0 && m.card.r <= m.W && m.card.b <= m.H, `${tag} : bulle hors écran`);
      if (!m.noHole) {
        assert.ok(m.hole.l >= -2 && m.hole.r <= m.W + 2 && m.hole.t >= -2 && m.hole.b <= m.H + 2, `${tag} : lumière hors écran`);
        const small = (m.hole.b - m.hole.t) < m.H * 0.5;
        if (small) {
          const overlap = !(m.card.r <= m.hole.l || m.card.l >= m.hole.r || m.card.b <= m.hole.t || m.card.t >= m.hole.b);
          assert.ok(!overlap, `${tag} : la bulle cache le bouton`);
        }
      }
      await p.click('#tour-next');
    }
    assert.equal(titles.size, total, 'chaque étape a son titre');
    assert.equal(await p.isVisible('#tour'), false, 'terminée');
    assert.deepEqual(p.errors, [], `${w}px : erreurs`);
    await p.context().close();
  }
});

test('visite guidée : clavier, précédent, et « Mes ami·es » ouvre les groupes', { skip }, async () => {
  const p = await page();
  await p.waitForSelector('#tour:not([hidden])');
  const first = await p.textContent('#tour-title');
  assert.equal(await p.isVisible('#tour-prev'), false, 'pas de « précédent » au début');
  await p.keyboard.press('ArrowRight');
  const second = await p.textContent('#tour-title');
  assert.notEqual(second, first);
  await p.click('#tour-prev');
  assert.equal(await p.textContent('#tour-title'), first);
  const total = Number((await p.textContent('#tour-step')).match(/sur (\d+)/)[1]);
  for (let i = 0; i < total - 1; i++) await p.keyboard.press('ArrowRight');
  assert.match(await p.textContent('#tour-title'), /parti/);
  await p.click('#tour-prev'); // « Mes ami·es »
  await p.waitForSelector('#sheet-groups:not([hidden])');
  assert.equal(await p.isVisible('#tour'), false);
  await p.reload();
  await p.waitForSelector('#conn.on');
  await p.waitForTimeout(300);
  assert.equal(await p.isVisible('#tour'), false);
  // Échap ferme la visite
  await p.click('#btn-info');
  await p.click('#open-tour');
  await p.keyboard.press('Escape');
  assert.equal(await p.isVisible('#tour'), false);
  await p.context().close();
});

test('signaler : compte demandé à un visiteur ; le signalement apparaît chez les autres, même sans compte', { skip }, async () => {
  const a = await page({ account: 'Rapporteur' });
  const b = await page();
  for (const p of [a, b]) if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
  await b.click('#btn-report');
  await b.click('.type-btn:has-text("Rue bloquée")');
  await b.waitForSelector('#auth[open]');
  await b.click('#auth-cancel');
  assert.equal(await b.isVisible('#place-bar'), false, 'pas de signalement sans compte');
  await a.click('#btn-report');
  await a.click('.type-btn:has-text("Rue bloquée")');
  await a.fill('#place-note', 'Barrage rue du Temple');
  await a.click('#place-send');
  await a.waitForSelector('.toast.ok');
  await b.waitForFunction(() => document.querySelectorAll('.rep-icon').length > 0);
  await a.context().close();
  await b.context().close();
});

test('XSS : pseudo, groupe et signalement piégés ne s’exécutent jamais', { skip }, async () => {
  const p = await page({ account: 'Piégé' });
  if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
  await p.click('#btn-groups');
  await p.click('#edit-nick');
  await p.fill('#modal-input', XSS.slice(0, 24));
  await p.click('#modal-ok');
  await p.click('text=Créer un groupe');
  await p.fill('#create-name', XSS.slice(0, 40));
  await p.fill('#create-desc', XSS);
  await p.click('#create-form button');
  await p.waitForSelector('.group h4');
  assert.equal(await p.textContent('.group h4'), XSS.slice(0, 40), 'affiché comme du texte');
  await closeSheet(p);
  await p.click('#btn-report');
  await p.click('.type-btn:has-text("Autre info")');
  // d'autres tests ont posé des signalements à la position simulée : on vise un endroit libre
  await p.mouse.move(200, 250);
  await p.mouse.down();
  await p.mouse.move(80, 200, { steps: 5 });
  await p.mouse.up();
  // la carte continue de glisser un instant (inertie) : on attend qu'elle soit immobile
  let last = '';
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(150);
    const now = await p.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform);
    if (now === last) break;
    last = now;
  }
  const target = await p.evaluate(() => {
    const r = document.querySelector('#crosshair').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await p.fill('#place-note', XSS);
  await p.click('#place-send');
  // le nouveau marqueur apparaît exactement sous le viseur : on clique à cet endroit
  await p.waitForFunction(({ x, y }) => [...document.querySelectorAll('.rep-icon')].some((el) => {
    const b = el.getBoundingClientRect();
    return Math.abs(b.left + b.width / 2 - x) < 3 && Math.abs(b.top + b.height / 2 - y) < 3;
  }), target);
  await p.mouse.click(target.x, target.y);
  await p.waitForSelector('.pop .note');
  assert.equal(await p.textContent('.pop .note'), XSS, 'signalement piégé affiché comme du texte');
  // via un autre client : notifications et listes
  const other = await s.user(XSS.slice(0, 20));
  await other.call('report', { type: 'gaz', ...REPU, note: '<svg onload="window.__xss=2">' });
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => window.__xss), undefined);
  assert.equal(await p.locator('img[src="x"]').count(), 0, 'aucune balise injectée');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('parcours complet entre deux téléphones : groupe, QR, acceptation, positions', { skip }, async () => {
  const alice = await page({ account: 'Alice' });
  const bob = await page({ account: 'Bob', geolocation: { latitude: REPU.lat + 0.001, longitude: REPU.lng } });
  for (const p of [alice, bob]) if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
  await alice.click('#btn-groups');
  await alice.click('text=Créer un groupe');
  await alice.fill('#create-name', 'Les potes');
  await alice.click('#create-form button');
  await alice.waitForSelector('.code-box code');
  const code = await alice.textContent('.code-box code');
  await alice.click('.code-box button:has-text("QR")');
  assert.ok(await alice.isVisible('#qr-img svg'), 'QR code affiché');
  await alice.click('#qr-modal button');

  await bob.goto(`${s.url}/?join=${code}`);
  await bob.waitForSelector('#join-code');
  assert.equal(await bob.inputValue('#join-code'), code, 'code prérempli depuis le lien');
  await bob.click('#join-form button');
  await bob.waitForSelector('.tag.pending');
  await alice.waitForSelector('.requests .btn.ok');
  await alice.click('.requests .btn.ok');
  await bob.waitForSelector('.group .tag:not(.pending)');
  for (const [p, mode] of [[alice, 'named'], [bob, 'anon']]) {
    if (await p.isVisible('.sheet-close >> visible=true')) await closeSheet(p);
    await p.click('#btn-share');
    await p.click(`input[name=mode][value=${mode}]`);
    await closeSheet(p);
  }
  await bob.waitForSelector('.mem-icon', { timeout: 10000 });
  assert.equal(await bob.textContent('.mem-icon'), 'AL');
  await alice.waitForSelector('.mem-icon', { timeout: 10000 });
  assert.equal(await alice.textContent('.mem-icon'), '?', 'Bob est anonyme');
  assert.deepEqual([...alice.errors, ...bob.errors], []);
  await alice.context().close();
  await bob.context().close();
});

test('effacement d’urgence : 3 touches sur le logo suppriment le compte et vident l’appareil', { skip }, async () => {
  const p = await page({ account: 'Effaçable' });
  if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
  await p.click('#btn-groups');
  assert.match(await p.textContent('#my-nick'), /Effaçable/);
  const before = await p.evaluate(() => JSON.parse(localStorage.getItem('mf_token')));
  await closeSheet(p);
  for (let i = 0; i < 3; i++) await p.click('.brand');
  await p.waitForURL(s.url + '/');
  await p.waitForSelector('#conn.on');
  // (le simulateur de test remet l'ancien jeton : il ne doit plus ouvrir aucune session)
  await p.waitForSelector('#tour:not([hidden])'); // appareil vidé : la visite revient
  await p.click('#tour-skip');
  await p.click('#btn-groups');
  assert.equal(await p.isVisible('#account-out'), true, 'plus connecté·e');
  assert.ok(before);
  assert.ok(!Object.values(s.state.db.users).some((u) => u.nickname === 'Effaçable'), 'supprimé du serveur');
  await p.context().close();
});

test('mise en page : aucun débordement horizontal, panneaux dans l’écran', { skip }, async () => {
  const sizes = [[320, 568], [360, 740], [375, 667], [390, 844], [768, 1024], [820, 1180], [1024, 768], [1180, 820], [1440, 900]];
  for (const [w, hgt] of sizes) {
    const p = await page({ viewport: { width: w, height: hgt } });
    if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
    for (const sheet of ['share', 'report', 'groups', 'layers', 'info']) {
      await p.click('#btn-' + sheet);
      await p.waitForTimeout(250);
      const m = await p.evaluate((id) => {
        const el = document.getElementById('sheet-' + id);
        const r = el.getBoundingClientRect();
        const overflowing = [...el.querySelectorAll('*')].filter((x) => {
          const b = x.getBoundingClientRect();
          return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1);
        }).map((x) => x.tagName + '.' + x.className).slice(0, 3);
        return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, left: r.left, right: r.right, overflowing };
      }, sheet);
      assert.ok(m.scroll <= m.inner, `${w}px ${sheet} : défilement horizontal`);
      assert.ok(m.left >= 0 && m.right <= m.inner + 1, `${w}px ${sheet} : panneau hors écran`);
      assert.deepEqual(m.overflowing, [], `${w}px ${sheet} : éléments qui débordent`);
      await closeSheet(p);
    }
    // cibles tactiles de la barre du bas assez grandes
    const small = await p.$$eval('.bottombar .nav-btn', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 40 || b.getBoundingClientRect().width < 44).length);
    assert.equal(small, 0, `${w}px : boutons trop petits`);
    assert.deepEqual(p.errors, [], `${w}px : erreurs`);
    await p.context().close();
  }
});

test('placement d’un signalement : le viseur reste visible au-dessus du panneau', { skip }, async () => {
  for (const [w, hgt] of [[320, 568], [375, 667], [390, 844], [820, 1180]]) {
    const p = await page({ viewport: { width: w, height: hgt }, account: 'Viseur' });
    if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
    await p.click('#btn-report');
    await p.click('.type-btn:has-text("Cortège")');
    const { pin, bar, top } = await p.evaluate(() => ({
      pin: document.querySelector('#crosshair span').getBoundingClientRect().top,
      bar: document.getElementById('place-bar').getBoundingClientRect().top,
      top: document.querySelector('.topbar').getBoundingClientRect().bottom,
    }));
    assert.ok(pin > top - 10 && pin + 44 < bar, `${w}x${hgt} : viseur caché (${pin} / ${bar})`);
    await p.context().close();
  }
});

test('carte OpenStreetMap via le service worker : les tuiles se chargent encore après un zoom', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
  const asked = [];
  await ctx.route(/tile\.openstreetmap\.org/, (r) => {
    asked.push(r.request().headers().referer || '');
    r.fulfill({ body: TILE, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
  });
  try {
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(s.url + '/');
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload();
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await p.waitForSelector('#conn.on');
    if (await p.isVisible('#tour-skip')) await p.click('#tour-skip');
    const z0 = await p.evaluate(() => JSON.parse(localStorage.getItem('mf_view') || '{"z":14}').z);
    for (let i = 0; i < 3; i++) { await p.click('.leaflet-control-zoom-in'); await p.waitForTimeout(300); }
    const z = z0 + 3;
    await p.waitForFunction((zoom) => JSON.parse(localStorage.getItem('mf_view') || '{}').z === zoom, z);
    // toutes les tuiles du nouveau niveau de zoom finissent chargées (aucune bloquée par la CSP du service worker)
    await p.waitForFunction((zoom) => {
      const imgs = [...document.querySelectorAll('img.leaflet-tile')].filter((i) => i.src.includes(`/${zoom}/`));
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, z, { timeout: 10000 });
    // la politique d'OpenStreetMap exige un Referer : on envoie l'origine du site, jamais l'adresse complète
    assert.ok(asked.length > 0);
    for (const r of asked) assert.equal(r, s.url + '/', 'Referer limité à l’origine');
    assert.deepEqual(p.errors, []);
  } finally {
    await ctx.close();
  }
});

test('carte partielle (Île-de-France) : OpenStreetMap prend le relais ailleurs, et inversement', { skip }, async () => {
  const fs = require('fs');
  const path = require('path');
  const head = Buffer.alloc(127);
  head.write('PMTiles', 0, 'latin1');
  head[7] = 3;
  head[101] = 15;
  [1.44, 48.12, 3.56, 49.24].forEach((v, i) => head.writeInt32LE(Math.round(v * 1e7), 102 + i * 4));
  const mapFile = path.join(s.dataDir, 'idf.pmtiles');
  fs.writeFileSync(mapFile, head);
  const s2 = await startServer({ mapFile, timers: false });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
  await ctx.addInitScript(() => localStorage.setItem('mf_welcomed', 'true'));
  try {
    const p = await ctx.newPage();
    const osmShown = () => p.evaluate(() => !!document.querySelector('.osm-tiles'));
    await p.goto(s2.url + '/');
    await p.waitForSelector('#conn.on');
    await p.waitForTimeout(500);
    assert.equal(await osmShown(), false, 'Paris : carte auto-hébergée');
    // pas d'accès direct à la carte Leaflet : on passe par la vue mémorisée et un rechargement
    await p.evaluate(() => localStorage.setItem('mf_view', JSON.stringify({ c: [45.7576, 4.832], z: 14 })));
    await p.reload();
    await p.waitForSelector('#conn.on');
    await p.waitForSelector('.osm-tiles', { state: 'attached' });
    // retour à Paris : la carte auto-hébergée revient
    await p.evaluate(() => localStorage.setItem('mf_view', JSON.stringify({ c: [48.8566, 2.3522], z: 14 })));
    await p.reload();
    await p.waitForSelector('#conn.on');
    await p.waitForTimeout(500);
    assert.equal(await osmShown(), false);
    // vue de toute la France : OpenStreetMap
    for (let i = 0; i < 6; i++) { await p.click('.leaflet-control-zoom-out'); await p.waitForTimeout(250); }
    await p.waitForSelector('.osm-tiles', { state: 'attached' });
  } finally {
    await ctx.close();
    await s2.stop();
  }
});

test('tracé automatique : les étapes écrites deviennent un parcours qui suit les rues', { skip }, async () => {
  const line = [[48.8674, 2.3631], [48.8722, 2.3601], [48.8765, 2.3575], [48.8838, 2.3497], [48.8826, 2.3376], [48.8836, 2.3275]];
  const s2 = await startServer({ timers: false, routePlanner: async (steps) => ({ points: line, via: 'ign', steps: steps.split('\n').map((text) => ({ text })) }) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
  await ctx.addInitScript(() => localStorage.setItem('mf_welcomed', 'true'));
  try {
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(s2.url + '/');
    await p.waitForSelector('#conn.on');
    await p.click('#btn-info');
    await p.click('#organizer-box summary');
    await p.fill('#organizer-key', 'cle-organisateur-de-test');
    await p.click('#organizer-form button');
    await p.waitForSelector('#sheet-orga:not([hidden])');
    await p.click('#orga-add');
    await p.fill('#draw-name', 'République → Clichy');
    await p.fill('#draw-time', '14:00');
    await p.fill('#draw-steps', 'Place de la République\nBoulevard de Magenta\nBarbès\nPlace de Clichy');
    // le champ et le bouton restent accessibles sur un téléphone
    await p.locator('#draw-plan').scrollIntoViewIfNeeded();
    assert.ok(await p.isVisible('#draw-plan'));
    await p.click('#draw-plan');
    await p.waitForFunction(() => /6 points/.test(document.getElementById('draw-count').textContent));
    assert.equal(await p.isVisible('#draw-fields'), false, 'formulaire replié pour voir le tracé');
    assert.equal(await p.locator('#draw-bar').evaluate(() => document.getElementById('draw-place').value), 'Place de la République', 'lieu de départ rempli');
    await p.click('#draw-save');
    await p.waitForSelector('#sheet-orga:not([hidden])');
    await p.waitForSelector('#orga-published .event-item');
    const ev = Object.values(s2.state.db.events)[0];
    assert.equal(ev.title, 'République → Clichy');
    assert.equal(ev.status, 'published');
    assert.deepEqual(ev.points, line);
    assert.deepEqual([ev.lat, ev.lng], line[0]);
    assert.deepEqual(p.errors, []);
  } finally {
    await ctx.close();
    await s2.stop();
  }
});

test('service worker : chaque plage d’octets de la carte est mise en cache séparément', { skip }, async () => {
  const fs = require('fs');
  const path = require('path');
  const mapFile = path.join(s.dataDir, 'carte-test.pmtiles');
  fs.writeFileSync(mapFile, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const s2 = await startServer({ mapFile, timers: false });
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const p = await ctx.newPage();
    await p.goto(s2.url + '/');
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload();
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    const read = (range) => p.evaluate(async (r) => {
      const res = await fetch('/map/carte.pmtiles', { headers: { Range: r } });
      return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] };
    }, range);
    for (let pass = 0; pass < 2; pass++) {
      // 2e passage : réponses servies par le cache du service worker
      assert.deepEqual((await read('bytes=0-3')).bytes, [0, 1, 2, 3], `passage ${pass}`);
      assert.deepEqual((await read('bytes=10-13')).bytes, [10, 11, 12, 13], `passage ${pass}`);
      assert.deepEqual((await read('bytes=200-201')).bytes, [200, 201], `passage ${pass}`);
    }
    assert.equal((await read('bytes=10-13')).status, 206);
  } finally {
    await ctx.close();
    await s2.stop();
  }
});

test('manifs : validation par un·e organisateur·ice, ajout manuel, affichage public sûr', { skip }, async () => {
  const batch = [
    { source: 'demosphere', sourceId: 'rv/1', title: 'Manif à Lyon <img src=x onerror="window.__xss=3">', date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }), time: '14:00', place: 'Place Bellecour', city: 'Lyon', lat: 45.7576, lng: 4.832, approx: false, url: 'https://lyon.example/rv/1' },
    { source: 'mobilizon', sourceId: 'm1', title: 'Rassemblement à Rennes', date: '2099-01-01', time: '', place: 'Place de la République', city: 'Rennes', lat: 48.1097, lng: -1.68, approx: true, url: 'javascript:alert(1)' },
  ];
  const s2 = await startServer({ timers: false, importer: async () => ({ events: batch, sources: [{ name: 'Démosphère test', ok: true, found: 2, kept: 2 }] }) });
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
    await ctx.addInitScript(() => localStorage.setItem('mf_welcomed', 'true'));
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(s2.url + '/');
    await p.waitForSelector('#conn.on');
    return p;
  };
  try {
    await s2.srv.runImport();
    const viewer = await mk();
    const orga = await mk();
    // rien de public avant validation
    await viewer.click('#btn-layers');
    assert.match(await viewer.textContent('#event-list'), /Aucune manif/);
    await viewer.click('.sheet-close >> visible=true');

    await orga.click('#btn-info');
    await orga.click('#organizer-box summary');
    await orga.fill('#organizer-key', 'cle-organisateur-de-test');
    await orga.click('#organizer-form button');
    await orga.waitForSelector('#sheet-orga:not([hidden])');
    await orga.waitForSelector('#orga-pending .event-item');
    assert.equal(await orga.locator('#orga-pending .event-item').count(), 2);
    assert.match(await orga.textContent('#orga-report'), /Démosphère test/);
    assert.equal(await orga.locator('#orga-pending a[href^="javascript"]').count(), 0, 'aucun lien javascript:');
    // publier la manif de Lyon
    await orga.locator('#orga-pending .event-item', { hasText: 'Lyon' }).locator('button', { hasText: 'Publier' }).click();
    await orga.waitForSelector('#orga-published .event-item');

    // ajout manuel avec parcours
    await orga.click('#orga-add');
    await orga.fill('#draw-name', 'République → Nation');
    await orga.fill('#draw-place', 'Place de la République');
    const barTop = await orga.evaluate(() => document.getElementById('draw-bar').getBoundingClientRect().top);
    await orga.mouse.click(150, barTop - 40);
    assert.equal(await orga.isVisible('#draw-fields'), false, 'champs repliés au premier point');
    const freed = await orga.evaluate(() => document.getElementById('draw-bar').getBoundingClientRect().top);
    assert.ok(freed > 844 * 0.6, `la carte reste visible pour tracer (panneau à ${freed}px)`);
    for (const [x, y] of [[200, freed - 150], [250, freed - 100]]) await orga.mouse.click(x, y);
    assert.match(await orga.textContent('#draw-count'), /3 points/);
    await orga.click('#draw-save');
    await orga.waitForSelector('#sheet-orga:not([hidden])');
    assert.equal(await orga.locator('#orga-published .event-item').count(), 2);

    // le visiteur voit les deux manifs publiées, pas celle en attente, sans exécution de code
    await viewer.waitForFunction(() => document.querySelectorAll('.event-icon').length >= 2);
    await viewer.click('#btn-layers');
    await viewer.waitForFunction(() => document.querySelectorAll('#event-list .event-item').length === 2);
    const txt = await viewer.textContent('#event-list');
    assert.match(txt, /Manif à Lyon <img/, 'titre affiché en texte');
    assert.doesNotMatch(txt, /Rennes/);
    assert.equal(await viewer.evaluate(() => window.__xss), undefined);
    await viewer.fill('#event-filter', 'nation');
    assert.equal(await viewer.locator('#event-list .event-item').count(), 1);
    await viewer.click('#event-list .event-item button');
    await viewer.waitForTimeout(400);
    assert.deepEqual([...viewer.errors, ...orga.errors], []);
    await viewer.context().close();
    await orga.context().close();
  } finally {
    await s2.stop();
  }
});

test('organisateur·ice : suppression d’un faux signalement depuis la carte', { skip }, async () => {
  const s2 = await startServer({ timers: false });
  try {
    const liar = await s2.connect();
    await liar.call('report', { type: 'calme', ...REPU, note: 'Fausse sortie sûre' });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce', geolocation: { latitude: REPU.lat, longitude: REPU.lng }, permissions: ['geolocation'] });
    await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
    await ctx.addInitScript(() => localStorage.setItem('mf_welcomed', 'true'));
    const p = await ctx.newPage();
    await p.goto(s2.url + '/');
    await p.waitForSelector('.rep-icon');
    await p.click('.rep-icon', { force: true });
    await p.waitForSelector('.pop');
    assert.equal(await p.locator('.report-delete').count(), 0, 'pas de bouton pour le public');
    await p.click('.leaflet-popup-close-button');
    await p.click('#btn-info');
    await p.click('#organizer-box summary');
    await p.fill('#organizer-key', 'cle-organisateur-de-test');
    await p.click('#organizer-form button');
    await p.waitForSelector('#sheet-orga:not([hidden])');
    await p.click('.sheet-close >> visible=true');
    await p.click('.rep-icon', { force: true });
    await p.click('.report-delete');
    await p.click('#modal-ok');
    await p.waitForFunction(() => document.querySelectorAll('.rep-icon').length === 0);
    assert.equal(s2.state.reports.size, 0);
    await ctx.close();
  } finally {
    await s2.stop();
  }
});
