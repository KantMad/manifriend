/* Manif Friend — client */
(() => {
  'use strict';

  const TYPES = {
    cortege: { label: 'Cortège', sub: 'où il est, où il va', emoji: '📣', color: '#7c5cff' },
    blocage: { label: 'Rue bloquée', sub: 'barrage, circulation coupée', emoji: '🚧', color: '#f97316' },
    nasse: { label: 'Nasse', sub: 'encerclement, sortie fermée', emoji: '⛔', color: '#c026d3' },
    gaz: { label: 'Gaz lacrymogène', sub: 'nuage, grenades', emoji: '💨', color: '#eab308' },
    violence: { label: 'Violences policières', sub: 'charge, coups, LBD', emoji: '⚠️', color: '#ef4444' },
    medic: { label: 'Street medics', sub: 'premiers secours ici', emoji: '⛑️', color: '#f8fafc' },
    calme: { label: 'Zone calme', sub: 'sortie sûre, point de repli', emoji: '🕊️', color: '#22c55e' },
    info: { label: 'Autre info', sub: 'à préciser', emoji: 'ℹ️', color: '#94a3b8' },
  };
  const ALERT_TYPES = new Set(['gaz', 'violence', 'nasse']);
  const ALERT_RADIUS = 400;
  const PARIS = [48.8566, 2.3522];
  const { ago, dist, fmtDist, colorFor, DIRS, headingLabel, initials, makeToken, inviteLink, joinCodeFromSearch } = window.MF;

  // ---------- Utilitaires ----------
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mf_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('mf_' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };
  function toast(text, kind = '') {
    const el = h('div', { class: 'toast ' + kind }, text);
    const box = $('#toasts');
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    el.addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), kind === 'alert' ? 9000 : 3500);
  }

  // ---------- Identité locale ----------
  let token = store.get('token');
  if (typeof token !== 'string' || token.length < 20) {
    token = makeToken((b) => crypto.getRandomValues(b));
    store.set('token', token);
  }

  const state = {
    me: null,
    groups: [],
    reports: new Map(),
    myPos: null,
    mode: store.get('mode', 'off'),
    hiddenGroups: new Set(store.get('hiddenGroups', [])),
    groupPos: new Map(), // groupId -> list
    alerts: store.get('alerts', true),
    routes: [],
    organizer: false,
  };

  // ---------- Carte ----------
  const map = L.map('map', {
    center: store.get('view', { c: PARIS }).c,
    zoom: store.get('view', { z: 14 }).z || 14,
    zoomControl: false,
    maxBounds: [[40.5, -6.5], [51.8, 10.5]],
    minZoom: 5,
    maxZoom: 19,
  });
  // Fond de carte : carte vectorielle hébergée sur notre serveur (aucun service tiers ne voit
  // quelles zones sont consultées) ; à défaut, ou hors de la zone qu'elle couvre, tuiles OpenStreetMap.
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  let baseLayer = null;
  let mapCfg = { map: 'osm' };
  let mapSource = 'osm';
  let mapMaxZoom = 15;
  // Carte partielle (ex. Île-de-France) : utilisée quand le centre de l'écran est dans sa zone, assez zoomé
  function wantedSource() {
    if (mapCfg.map !== 'pmtiles') return 'osm';
    if (!mapCfg.partial || !mapCfg.bounds) return 'pmtiles';
    return map.getZoom() >= 9 && L.latLngBounds(mapCfg.bounds).contains(map.getCenter()) ? 'pmtiles' : 'osm';
  }
  function makeBaseLayer() {
    const dark = store.get('darkMap', false);
    document.body.classList.toggle('dark-map', dark);
    if (mapSource === 'pmtiles' && window.protomapsL) {
      return protomapsL.leafletLayer({
        url: '/map/carte.pmtiles', flavor: dark ? 'dark' : 'light', lang: 'fr', maxDataZoom: mapMaxZoom,
        attribution: OSM_ATTR + ' · Protomaps',
      });
    }
    // crossOrigin : réponses lisibles, le service worker ne garde que les tuiles valides.
    // Referer réduit à l'origine du site : exigé par la politique d'usage d'OpenStreetMap.
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: OSM_ATTR, className: 'osm-tiles', crossOrigin: 'anonymous', referrerPolicy: 'strict-origin',
    });
  }
  // Remplace le fond de carte ; l'ancien reste affiché jusqu'à ce que le nouveau soit prêt (pas de clignotement)
  function setBaseMap() {
    const old = baseLayer;
    baseLayer = makeBaseLayer();
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    if (!old) return;
    old.bringToBack();
    let removed = false;
    const drop = () => { if (!removed) { removed = true; map.removeLayer(old); } };
    baseLayer.once('load', drop);
    setTimeout(drop, 3000);
  }
  fetch('/config.json')
    .then((r) => r.json())
    .catch(() => ({ map: 'osm' }))
    .then((cfg) => { mapCfg = cfg; mapMaxZoom = cfg.maxzoom || 15; mapSource = wantedSource(); setBaseMap(); });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.on('moveend', () => {
    store.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() });
    const want = wantedSource();
    if (baseLayer && want !== mapSource) { mapSource = want; setBaseMap(); }
  });

  const densityLayer = L.layerGroup().addTo(map);
  const reportLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const groupLayer = L.layerGroup().addTo(map);
  let meMarker = null, meCircle = null;
  const reportMarkers = new Map();

  // ---------- Connexion temps réel ----------
  const socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  const emit = (ev, data) => new Promise((res) => socket.emit(ev, data, (r) => res(r || {})));

  socket.on('connect', () => {
    $('#conn').classList.add('on');
    $('#conn').title = 'Connecté';
    if (state.myPos && state.mode !== 'off') sendPos();
  });
  socket.on('disconnect', (reason) => {
    $('#conn').classList.remove('on');
    $('#conn').title = 'Déconnecté — reconnexion…';
    // Session fermée par le serveur (mot de passe changé ailleurs…) : on revient en simple visiteur
    if (reason === 'io server disconnect') setTimeout(() => socket.connected || socket.connect(), 500);
  });
  socket.on('connect_error', () => $('#conn').classList.remove('on'));

  socket.on('init', (d) => {
    state.me = d.me;
    showAccount();
    if (!d.me.account && state.mode !== 'off') state.mode = 'off'; // plus de compte : plus de partage
    state.reports.clear();
    reportLayer.clearLayers();
    reportMarkers.clear();
    d.reports.forEach((r) => upsertReport(r, false));
    drawDensity(d.density);
    setGroups(d.groups);
    drawRoutes(d.events);
    $('#organizer-box').hidden = !d.organizerEnabled;
    if (d.organizerEnabled && store.get('orgKey')) unlockOrganizer(store.get('orgKey'), true);
    setMode(state.mode);
    if (!store.get('welcomed') && !joinCodeFromSearch(location.search) && !tour.active) tour.start();
    handleJoinLink();
  });
  socket.on('groups', setGroups);
  // Signalements reçus par lots (au plus un message par seconde)
  socket.on('reports', (m) => {
    (m.add || []).forEach((r) => upsertReport(r, true));
    (m.update || []).forEach((r) => upsertReport(r, false));
    (m.remove || []).forEach(removeReport);
  });
  socket.on('density', drawDensity);
  socket.on('events', drawRoutes);
  socket.on('group:pos', ({ groupId, list }) => {
    state.groupPos.set(groupId, list);
    drawGroups();
  });
  socket.on('notify', (n) => {
    toast(n.text, n.kind === 'ok' ? 'ok' : '');
    if (navigator.vibrate) navigator.vibrate(100);
  });

  // ---------- Signalements ----------
  function reportIcon(r) {
    const t = TYPES[r.type];
    const fresh = Date.now() - r.createdAt < 5 * 60000;
    const arrow = r.heading != null ? `<span class="arrow" style="transform:rotate(${Number(r.heading)}deg)"></span>` : '';
    return L.divIcon({
      className: '',
      html: `<div class="rep-icon${fresh ? ' fresh' : ''}" style="--c:${t.color}">${arrow}${t.emoji}</div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -18],
    });
  }
  function reportPopup(r) {
    const t = TYPES[r.type];
    const vote = async (v) => {
      if (!(await ensureAccount())) return;
      const res = await emit('vote', { id: r.id, v });
      if (res.error) toast(res.error);
      else { store.set('vote_' + r.id, v); map.closePopup(); }
    };
    const my = store.get('vote_' + r.id, 0);
    const parts = [ago(r.createdAt), `expire ${new Date(r.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`];
    if (state.myPos) parts.push(fmtDist(dist(state.myPos, r)));
    return h('div', { class: 'pop' },
      h('h4', {}, `${t.emoji} ${t.label}`),
      r.heading != null ? h('div', {}, `Direction : ${headingLabel(r.heading)}`) : null,
      r.note ? h('div', { class: 'note' }, r.note) : null,
      h('div', { class: 'meta' }, parts.join(' · ')),
      h('div', { class: 'votes' },
        h('button', { class: 'btn small ok', onclick: () => vote(1) }, `👍 Confirmé ${r.up}`, my === 1 ? ' ✓' : ''),
        h('button', { class: 'btn small no', onclick: () => vote(-1) }, `👎 Plus là ${r.down}`, my === -1 ? ' ✓' : '')),
      state.organizer ? h('button', { class: 'btn small danger outline report-delete', onclick: () => confirmThen('Supprimer ce signalement pour tout le monde ?', async () => {
        const res = await act('report:delete', { id: r.id });
        if (res.ok) { map.closePopup(); toast('Signalement supprimé', 'ok'); }
      }) }, '🗑️ Supprimer (organisateur·ice)') : null);
  }
  function upsertReport(r, isNew) {
    if (!TYPES[r.type]) return;
    state.reports.set(r.id, r);
    let m = reportMarkers.get(r.id);
    if (!m) {
      m = L.marker([r.lat, r.lng], { icon: reportIcon(r), zIndexOffset: ALERT_TYPES.has(r.type) ? 600 : 400 }).addTo(reportLayer);
      reportMarkers.set(r.id, m);
    } else m.setIcon(reportIcon(r));
    m.unbindPopup().bindPopup(() => reportPopup(state.reports.get(r.id) || r));
    if (isNew && ALERT_TYPES.has(r.type) && state.alerts && state.myPos) {
      const d = dist(state.myPos, r);
      if (d <= ALERT_RADIUS) {
        toast(`${TYPES[r.type].emoji} ${TYPES[r.type].label} signalé à ${fmtDist(d)} de toi`, 'alert');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      }
    }
  }
  function removeReport(id) {
    state.reports.delete(id);
    const m = reportMarkers.get(id);
    if (m) { reportLayer.removeLayer(m); reportMarkers.delete(id); }
  }
  // Rafraîchir l'effet « récent » des icônes
  setInterval(() => state.reports.forEach((r) => reportMarkers.get(r.id)?.setIcon(reportIcon(r))), 60000);

  // ---------- Foule agrégée ----------
  function drawDensity(cells) {
    densityLayer.clearLayers();
    for (const c of cells || []) {
      const intensity = Math.min(1, c.n / 40);
      L.circle([c.lat, c.lng], {
        radius: 130,
        stroke: false,
        fillColor: '#ff4f7b',
        fillOpacity: 0.18 + intensity * 0.35,
        interactive: true,
      }).bindTooltip(`Foule : ${c.n} utilisateur·ices`, { direction: 'top' }).addTo(densityLayer);
    }
  }

  // ---------- Groupes ----------
  function setGroups(groups) {
    state.groups = groups;
    const ids = new Set(groups.filter((g) => g.status === 'member').map((g) => g.id));
    for (const id of state.groupPos.keys()) if (!ids.has(id)) state.groupPos.delete(id);
    const pend = groups.reduce((n, g) => n + (g.pending ? g.pending.length : 0), 0);
    $('#groups-badge').hidden = pend === 0;
    $('#groups-badge').textContent = pend;
    renderGroups();
    drawGroups();
  }

  function drawGroups() {
    groupLayer.clearLayers();
    if (!$('#layer-groups').checked) return;
    const seen = new Set();
    for (const g of state.groups) {
      if (g.status !== 'member' || state.hiddenGroups.has(g.id)) continue;
      const color = colorFor(g.id);
      if (g.meet) drawMeet(g, color);
      for (const p of state.groupPos.get(g.id) || []) {
        if (p.id === state.me?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const stale = Date.now() - p.ts > 2 * 60000;
        const label = initials(p.nickname);
        const icon = L.divIcon({
          className: '',
          html: `<div class="mem-icon${stale ? ' stale' : ''}" style="--c:${color}"></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        const m = L.marker([p.lat, p.lng], { icon, zIndexOffset: 300 }).addTo(groupLayer);
        m.getElement().querySelector('.mem-icon').textContent = label;
        m.bindPopup(() => h('div', { class: 'pop' },
          h('h4', {}, p.nickname || 'Membre anonyme'),
          h('div', { class: 'meta' }, [g.name, ago(p.ts), state.myPos ? `à ${fmtDist(dist(state.myPos, p))}` : null].filter(Boolean).join(' · '))));
      }
    }
  }

  const meetTitle = (m) => [m.label || 'Point de rendez-vous', m.date ? dayLabel(m.date).toLowerCase() : '', m.time ? `à ${m.time}` : ''].filter(Boolean).join(' ');
  function walkLink(to) {
    const from = state.myPos ? `${state.myPos.lat},${state.myPos.lng}` : '';
    return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${from};${to.lat},${to.lng}`;
  }
  function drawMeet(g, color) {
    const m = g.meet;
    const icon = L.divIcon({ className: '', html: `<div class="meet-icon" style="--c:${color}"><span>🚩</span></div>`, iconSize: [36, 36], iconAnchor: [18, 40], popupAnchor: [0, -38] });
    L.marker([m.lat, m.lng], { icon, zIndexOffset: 700 }).addTo(groupLayer).bindPopup(() => h('div', { class: 'pop' },
      h('h4', {}, `🚩 ${meetTitle(m)}`),
      m.note ? h('div', { class: 'note' }, m.note) : null,
      h('div', { class: 'meta' }, '🔒 Visible uniquement par les membres du groupe'),
      h('div', { class: 'meta' }, [`Groupe « ${g.name} »`, `fixé par ${m.by}`, ago(m.at), state.myPos ? `à ${fmtDist(dist(state.myPos, m))}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'votes' }, h('a', { class: 'btn small primary', href: walkLink(m), target: '_blank', rel: 'noopener' }, '🚶 Itinéraire à pied'))));
  }
  function meetBox(g, admin) {
    const box = h('div', { class: 'meet-box' });
    if (g.meet) {
      // (append transformerait un null en texte « null » : on filtre)
      box.append(...[h('div', {}, '🚩 ', h('strong', {}, meetTitle(g.meet))),
        g.meet.note ? h('div', { style: 'margin-top:4px' }, g.meet.note) : null,
        h('div', { class: 'hint', style: 'margin:2px 0 0' }, `🔒 Groupe uniquement · Fixé par ${g.meet.by} · ${ago(g.meet.at)}${state.myPos ? ' · à ' + fmtDist(dist(state.myPos, g.meet)) : ''}`)].filter(Boolean));
    } else box.append(h('div', { class: 'hint', style: 'margin:0' }, admin ? 'Aucun point de rendez-vous. Fixe-en un pour que le groupe se retrouve si on se perd.' : 'Pas encore de point de rendez-vous.'));
    const acts = h('div', { class: 'sub-actions' });
    if (g.meet) acts.append(h('button', { class: 'btn small ghost', onclick: () => { closeSheets(); map.setView([g.meet.lat, g.meet.lng], 17); } }, 'Voir sur la carte'));
    if (admin) {
      acts.append(h('button', { class: 'btn small primary', onclick: () => startMeet(g) }, g.meet ? 'Déplacer' : '🚩 Fixer le rendez-vous'));
      if (g.meet) acts.append(h('button', { class: 'btn small no', onclick: () => act('group:meet', { groupId: g.id, clear: true }) }, 'Retirer'));
    }
    if (acts.children.length) box.append(acts);
    return box;
  }

  function renderGroups() {
    const list = $('#group-list');
    list.replaceChildren();
    if (!state.groups.length) {
      list.append(h('div', { class: 'card empty' },
        h('strong', {}, 'Comment retrouver tes ami·es ?'),
        h('ol', { class: 'tips' },
          h('li', {}, 'Une personne crée le groupe (➕ en bas) : elle en devient admin.'),
          h('li', {}, 'Elle montre son QR code ou envoie le lien d’invitation.'),
          h('li', {}, 'Les autres scannent avec l’appareil photo ou ouvrent le lien, puis envoient une demande.'),
          h('li', {}, 'L’admin accepte : vous vous voyez sur la carte dès que vous partagez votre position.'))));
      return;
    }
    for (const g of state.groups) list.append(groupCard(g));
  }

  function groupCard(g) {
    const color = colorFor(g.id);
    if (g.status === 'pending') {
      return h('div', { class: 'group', style: `--c:${color}` },
        h('div', { class: 'group-head' }, h('h4', {}, g.name), h('span', { class: 'tag pending' }, 'En attente')),
        h('p', { class: 'desc' }, 'Ta demande attend la validation d’un·e administrateur·ice.'),
        h('div', { class: 'sub-actions' }, h('button', { class: 'btn small ghost', onclick: () => act('group:leave', { groupId: g.id }) }, 'Annuler la demande')));
    }
    const admin = g.role === 'admin';
    const live = (state.groupPos.get(g.id) || []).filter((p) => p.id !== state.me?.id).length;
    const visible = !state.hiddenGroups.has(g.id);
    const card = h('div', { class: 'group', style: `--c:${color}` },
      h('div', { class: 'group-head' },
        h('h4', {}, g.name),
        h('span', { class: 'tag' + (admin ? ' admin' : '') }, admin ? 'Admin' : 'Membre')),
      g.description ? h('p', { class: 'desc' }, g.description) : null,
      h('div', { class: 'live' }, `● ${live} membre${live > 1 ? 's' : ''} visible${live > 1 ? 's' : ''} sur la carte · ${g.members.length} au total`),
      h('label', { class: 'switch-row' },
        h('input', { type: 'checkbox', checked: visible, onchange: (e) => {
          if (e.target.checked) state.hiddenGroups.delete(g.id); else state.hiddenGroups.add(g.id);
          store.set('hiddenGroups', [...state.hiddenGroups]);
          drawGroups();
        } }), 'Afficher ce groupe sur la carte'),
      meetBox(g, admin));

    if (admin) {
      const link = inviteLink(location.origin, g.code);
      card.append(h('div', { class: 'code-box' },
        h('span', { class: 'hint', style: 'margin:0' }, 'Code :'), h('code', {}, g.code),
        h('button', { class: 'btn small primary', onclick: () => share(g, link) }, 'Partager'),
        h('button', { class: 'btn small ghost', title: 'Afficher le QR code', onclick: () => showQR(g, link) }, 'QR'),
        h('button', { class: 'btn small ghost', title: 'Générer un nouveau code', onclick: () => act('group:code', { groupId: g.id }) }, '↻')));
      if (g.pending.length) {
        card.append(h('div', { class: 'requests' },
          h('strong', {}, `Demandes d’adhésion (${g.pending.length})`),
          g.pending.map((p) => h('div', { class: 'member' },
            h('span', {}, p.nickname, h('span', { class: 'hint' }, ' · ' + ago(p.at))),
            h('span', { class: 'acts' },
              h('button', { class: 'btn small ok', onclick: () => act('group:approve', { groupId: g.id, userId: p.id }) }, '✓ Accepter'),
              h('button', { class: 'btn small no', onclick: () => act('group:reject', { groupId: g.id, userId: p.id }) }, '✗'))))));
      }
    }

    const members = h('details', {},
      h('summary', { class: 'hint', style: 'cursor:pointer' }, `Membres (${g.members.length})`),
      g.members.map((m) => h('div', { class: 'member' },
        h('span', {}, m.nickname, m.me ? ' (moi)' : '', m.role === 'admin' ? ' ★' : ''),
        admin && !m.me ? h('span', { class: 'acts' },
          h('button', { class: 'btn small ghost', onclick: () => act('group:promote', { groupId: g.id, userId: m.id }) }, m.role === 'admin' ? 'Retirer admin' : 'Admin'),
          h('button', { class: 'btn small no', onclick: () => confirmThen(`Retirer ${m.nickname} du groupe ?`, () => act('group:kick', { groupId: g.id, userId: m.id })) }, 'Retirer')) : null)));
    card.append(members);

    card.append(h('div', { class: 'sub-actions' },
      h('button', { class: 'btn small ghost', onclick: () => confirmThen(`Quitter « ${g.name} » ?`, () => act('group:leave', { groupId: g.id })) }, 'Quitter'),
      admin ? h('button', { class: 'btn small no', onclick: () => confirmThen(`Supprimer définitivement « ${g.name} » pour tout le monde ?`, () => act('group:delete', { groupId: g.id })) }, 'Supprimer le groupe') : null));
    return card;
  }

  async function act(ev, data) {
    const r = await emit(ev, data);
    if (r.error === 'Clé révoquée') {
      state.organizer = false;
      store.set('orgKey', null);
      $('#organizer-form').hidden = false;
      $('#organizer-tools').hidden = true;
    }
    if (r.auth && state.me) { state.me.account = false; showAccount(); }
    if (r.error) toast(r.error);
    return r;
  }
  function showQR(g, link) {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    // SVG généré localement à partir du lien (code serveur [A-Z0-9] uniquement)
    $('#qr-img').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    $('#qr-title').textContent = g.name;
    $('#qr-code').textContent = g.code;
    $('#qr-modal').showModal();
  }
  async function share(g, link) {
    const text = `Rejoins mon groupe « ${g.name} » sur Manif Friend (code ${g.code}) :`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Manif Friend', text, url: link }); return; } catch { /* annulé */ }
    }
    try { await navigator.clipboard.writeText(`${text} ${link}`); toast('Lien copié'); } catch { toast(link); }
  }

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await ensureAccount())) return;
    const r = await act('group:join', { code: $('#join-code').value });
    if (r.ok) { toast(`Demande envoyée à « ${r.name} »`, 'ok'); $('#join-code').value = ''; }
  });
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await ensureAccount())) return;
    const r = await act('group:create', { name: $('#create-name').value, description: $('#create-desc').value });
    if (r.ok) { toast('Groupe créé — partage le code à tes ami·es', 'ok'); e.target.reset(); e.target.closest('details').open = false; }
  });

  function handleJoinLink() {
    const code = joinCodeFromSearch(location.search);
    if (!code) return;
    history.replaceState(null, '', '/');
    openSheet('groups');
    $('#join-box').open = true;
    $('#join-code').value = code;
  }

  // ---------- Pseudo & dialogues ----------
  function modal({ title, text, input, okLabel = 'OK' }) {
    const dlg = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text || '';
    $('#modal-input').hidden = input == null;
    $('#modal-input').value = input || '';
    $('#modal-ok').textContent = okLabel;
    dlg.showModal();
    if (input != null) setTimeout(() => $('#modal-input').focus(), 50);
    return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? $('#modal-input').value : null), { once: true }));
  }
  async function confirmThen(text, fn) {
    if ((await modal({ title: text, okLabel: 'Confirmer' })) !== null) fn();
  }
  // Consentement explicite avant tout pseudo ou partage de position (version du texte accepté)
  const CONSENT_V = 2; // 2 : comptes (pseudo + mot de passe)
  const hasConsent = () => (store.get('consent', null) || {}).v === CONSENT_V;
  function ensureConsent() {
    if (hasConsent()) return Promise.resolve(true);
    const dlg = $('#consent');
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((res) => dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      if (ok) store.set('consent', { v: CONSENT_V, at: Date.now() });
      else toast('Sans ton accord, rien n\u2019est partagé. Tu peux toujours consulter la carte.');
      res(ok);
    }, { once: true }));
  }
  // Changement de pseudo (compte connecté)
  async function askNick() {
    if (!(await ensureAccount())) return false;
    const v = await modal({
      title: 'Changer de pseudo',
      text: 'Visible uniquement par les membres de tes groupes. Évite ton vrai nom.',
      input: state.me?.nickname || '',
    });
    if (v == null || !v.trim()) return false;
    const r = await act('profile', { nickname: v });
    if (r.ok) { state.me.nickname = v.trim().slice(0, 24); showAccount(); setMode(state.mode); }
    return !!r.ok;
  }
  $('#edit-nick').addEventListener('click', askNick);

  // ---------- Compte : pseudo + mot de passe, sans e-mail ----------
  // Après connexion, le serveur donne un jeton de session : il remplace le jeton de l'appareil
  // et la connexion temps réel est rouverte avec lui. La session reste ouverte jusqu'à déconnexion.
  function useToken(t) {
    token = t;
    store.set('token', t);
    socket.auth.token = t;
    const ready = new Promise((res) => socket.once('init', res));
    socket.disconnect();
    socket.connect();
    return ready;
  }
  function showAccount() {
    const logged = !!state.me?.account;
    $('#account-in').hidden = !logged;
    $('#account-out').hidden = logged;
    $('#my-nick').textContent = state.me?.nickname || '—';
  }
  const AUTH_MODES = {
    register: { title: 'Créer un compte', ok: 'Créer mon compte', hint: 'Juste un pseudo et un mot de passe : ni e-mail, ni numéro. Tu restes connecté·e sur cet appareil.', fields: ['name', 'pass'] },
    login: { title: 'Se connecter', ok: 'Se connecter', hint: 'Avec le pseudo et le mot de passe choisis à la création du compte.', fields: ['name', 'pass'] },
    recover: { title: 'Mot de passe oublié', ok: 'Changer le mot de passe', hint: 'Entre le code de secours affiché à la création du compte, puis un nouveau mot de passe.', fields: ['name', 'code', 'pass'] },
    password: { title: 'Changer le mot de passe', ok: 'Changer', hint: 'Tes autres appareils seront déconnectés.', fields: ['old', 'pass'] },
  };
  let authMode = 'register';
  let authDone = null;
  function setAuthMode(mode) {
    authMode = mode;
    const m = AUTH_MODES[mode];
    $('#auth-title').textContent = m.title;
    $('#auth-ok').textContent = m.ok;
    $('#auth-hint').textContent = m.hint;
    $('#auth-error').textContent = '';
    for (const f of ['name', 'code', 'old', 'pass']) $('#auth-' + f).hidden = !m.fields.includes(f);
    $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-pass').placeholder = mode === 'login' ? 'Mot de passe' : mode === 'register' ? 'Mot de passe (8 caractères minimum)' : 'Nouveau mot de passe (8 caractères minimum)';
    $('#auth-to-login').hidden = mode === 'login' || mode === 'password';
    $('#auth-to-register').hidden = mode === 'register' || mode === 'password';
    $('#auth-to-recover').hidden = mode === 'recover' || mode === 'password';
  }
  function openAuth(mode = 'register') {
    setAuthMode(mode);
    $('#auth-form').reset();
    $('#auth-pass').type = $('#auth-old').type = 'password';
    $('#auth').showModal();
    setTimeout(() => (mode === 'password' ? $('#auth-old') : $('#auth-name')).focus(), 50);
    return new Promise((res) => (authDone = res));
  }
  function closeAuth(ok) {
    if ($('#auth').open) $('#auth').close();
    if (authDone) { authDone(ok); authDone = null; }
  }
  function showRecovery(code) {
    $('#recovery-code').textContent = code;
    $('#recovery-done').checked = false;
    $('#recovery-ok').disabled = true;
    $('#recovery').showModal();
    return new Promise((res) => $('#recovery').addEventListener('close', res, { once: true }));
  }
  $('#recovery-done').addEventListener('change', (e) => { $('#recovery-ok').disabled = !e.target.checked; });
  $('#recovery').addEventListener('cancel', (e) => { if ($('#recovery-ok').disabled) e.preventDefault(); }); // pas de fermeture avant d'avoir noté
  $('#recovery-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#recovery-code').textContent); toast('Code copié', 'ok'); } catch { toast('Copie impossible : recopie-le à la main'); }
  });
  $('#auth-show').addEventListener('change', (e) => { $('#auth-pass').type = $('#auth-old').type = e.target.checked ? 'text' : 'password'; });
  $('#auth-cancel').addEventListener('click', () => closeAuth(false));
  $('#auth').addEventListener('cancel', () => closeAuth(false));
  for (const m of ['login', 'register', 'recover']) $('#auth-to-' + m).addEventListener('click', (e) => { e.preventDefault(); setAuthMode(m); });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-ok');
    if (btn.disabled) return;
    btn.disabled = true;
    const name = $('#auth-name').value.trim();
    const password = $('#auth-pass').value;
    const ev = { register: 'account:register', login: 'account:login', recover: 'account:recover', password: 'account:password' }[authMode];
    const r = await emit(ev, { name, password, code: $('#auth-code').value, old: $('#auth-old').value });
    btn.disabled = false;
    if (r.error) { $('#auth-error').textContent = r.error; return; }
    if (authMode === 'password') { closeAuth(true); toast('Mot de passe changé', 'ok'); return; }
    const mode = authMode;
    $('#auth').close();
    await useToken(r.token);
    if (r.recovery) await showRecovery(r.recovery);
    toast(mode === 'register' ? `Bienvenue ${r.name} !` : `Connecté·e en tant que ${r.name}`, 'ok');
    closeAuth(true);
  });
  $('#account-register').addEventListener('click', async () => { if (await ensureConsent()) openAuth('register'); });
  $('#account-login').addEventListener('click', async () => { if (await ensureConsent()) openAuth('login'); });
  $('#account-password').addEventListener('click', () => openAuth('password'));
  $('#account-logout').addEventListener('click', () => confirmThen('Se déconnecter de cet appareil ?', async () => {
    setMode('off');
    await Promise.race([emit('account:logout'), new Promise((r) => setTimeout(r, 1500))]);
    await useToken(makeToken((b) => crypto.getRandomValues(b)));
    toast('Déconnecté·e', 'ok');
  }));
  // Avant d'agir : accord pour les données sensibles, puis compte (création proposée, connexion possible)
  async function ensureAccount() {
    if (state.me?.account) return true;
    if (!(await ensureConsent())) return false;
    return openAuth('register');
  }

  // ---------- Géolocalisation ----------
  let watchId = null;
  let lastSent = 0;
  let wakeLock = null;

  function startWatch() {
    if (watchId != null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(onPos, onPosError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function onPos(p) {
    const first = !state.myPos;
    state.myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    const ll = [state.myPos.lat, state.myPos.lng];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, interactive: false }).addTo(map);
      meCircle = L.circle(ll, { radius: state.myPos.acc, color: '#3b82f6', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
      meCircle.setLatLng(ll).setRadius(state.myPos.acc);
    }
    if (first && store.get('centerOnStart', true)) map.setView(ll, Math.max(map.getZoom(), 15));
    if (state.mode !== 'off' && Date.now() - lastSent > 5000) sendPos();
  }
  function onPosError(e) {
    if (e.code === 1) {
      toast('Géolocalisation refusée : autorise-la dans les réglages du navigateur.');
      setMode('off');
    }
  }
  function sendPos() {
    if (!state.myPos) return;
    lastSent = Date.now();
    socket.emit('pos', { lat: state.myPos.lat, lng: state.myPos.lng, acc: state.myPos.acc, mode: state.mode });
  }
  // Renvoi régulier même immobile, sinon la position expire
  setInterval(() => { if (state.mode !== 'off' && Date.now() - lastSent > 30000) sendPos(); }, 10000);

  function setMode(mode) {
    state.mode = mode;
    store.set('mode', mode);
    document.querySelectorAll('input[name=mode]').forEach((i) => { i.checked = i.value === mode; });
    const pill = $('#share-pill');
    pill.className = 'pill ' + mode;
    pill.textContent = { off: 'Position : off', anon: '🕶️ Anonyme', named: '🙋 ' + (state.me?.nickname || 'Visible') }[mode];
    if (mode === 'off') socket.emit('pos:stop');
    else { startWatch(); sendPos(); }
  }
  document.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', async () => {
    if (i.value !== 'off' && !(await ensureAccount())) { setMode(state.mode); return; }
    setMode(i.value);
    toast({ off: 'Partage arrêté', anon: 'Partage anonyme activé', named: 'Partage avec pseudo activé' }[i.value], 'ok');
  }));

  $('#wakelock').addEventListener('change', async (e) => {
    if (!('wakeLock' in navigator)) { toast('Non disponible sur ce navigateur'); e.target.checked = false; return; }
    if (e.target.checked) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { e.target.checked = false; }
    } else if (wakeLock) { wakeLock.release(); wakeLock = null; }
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && $('#wakelock').checked) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignoré */ }
    }
  });

  $('#btn-locate').addEventListener('click', () => {
    if (state.myPos) map.setView([state.myPos.lat, state.myPos.lng], Math.max(map.getZoom(), 16));
    else { startWatch(); toast('Recherche de ta position…'); }
  });

  // ---------- Placement d'un signalement ----------
  let placing = null;
  function showPlaceBar(emoji, label, notePlaceholder) {
    closeSheets();
    $('#place-emoji').textContent = emoji;
    $('#place-label').textContent = label;
    $('#place-note').value = '';
    $('#place-note').placeholder = notePlaceholder;
    $('#place-meet-fields').hidden = true;
    $('#heading-picker').hidden = true;
    $('#place-bar').hidden = false;
    $('.bottombar').hidden = true;
  }
  // Le viseur se place au milieu de la zone de carte visible, au-dessus du panneau
  function targetPoint() {
    const top = $('.topbar').offsetHeight;
    const bottom = $('#place-bar').hidden ? map.getSize().y : $('#place-bar').getBoundingClientRect().top;
    return L.point(map.getSize().x / 2, Math.round((top + bottom) / 2));
  }
  function aimReady(ll) {
    const p = targetPoint();
    $('#crosshair').style.top = p.y + 'px';
    $('#crosshair').hidden = false;
    if (!ll) return;
    map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 16), { animate: false });
    map.panBy([0, map.getSize().y / 2 - p.y], { animate: false });
  }
  window.addEventListener('resize', () => { if (placing) aimReady(null); });
  function startMeet(g) {
    showPlaceBar('🚩', `Rendez-vous · ${g.name}`, 'Nom du lieu (ex. sortie métro Oberkampf)');
    placing = { kind: 'meet', groupId: g.id };
    $('#place-note').maxLength = 60;
    $('#place-note').value = g.meet?.label || '';
    $('#place-time').value = g.meet?.time || '';
    $('#place-date').value = g.meet?.date || '';
    $('#place-date').min = today();
    $('#place-meet-note').value = g.meet?.note || '';
    $('#place-meet-fields').hidden = false;
    aimReady(g.meet || state.myPos);
  }
  async function startPlacing(type) {
    if (!(await ensureAccount())) return;
    const t = TYPES[type];
    showPlaceBar(t.emoji, t.label, 'Précision (facultatif) : ex. « rue bloquée par CRS »');
    placing = { kind: 'report', type, heading: null };
    $('#place-note').maxLength = 140;
    $('#heading-picker').hidden = type !== 'cortege';
    $('#compass').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    aimReady(state.myPos);
  }
  function stopPlacing() {
    placing = null;
    $('#crosshair').hidden = true;
    $('#place-bar').hidden = true;
    $('.bottombar').hidden = false;
  }
  DIRS.forEach((d, i) => {
    const b = h('button', { type: 'button', title: d, onclick: () => {
      placing.heading = placing.heading === i * 45 ? null : i * 45;
      $('#compass').querySelectorAll('button').forEach((x, j) => x.classList.toggle('on', placing.heading === j * 45));
    } }, ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][i]);
    $('#compass').append(b);
  });
  $('#place-cancel').addEventListener('click', stopPlacing);
  $('#place-send').addEventListener('click', async () => {
    if (!placing) return;
    const c = map.containerPointToLatLng(targetPoint());
    if (placing.kind === 'meet') {
      const r = await act('group:meet', { groupId: placing.groupId, lat: c.lat, lng: c.lng, label: $('#place-note').value, time: $('#place-time').value, date: $('#place-date').value, note: $('#place-meet-note').value });
      if (r.ok) { toast('Rendez-vous partagé avec le groupe', 'ok'); stopPlacing(); }
      return;
    }
    $('#place-send').disabled = true;
    const r = await emit('report', { type: placing.type, lat: c.lat, lng: c.lng, note: $('#place-note').value, heading: placing.heading });
    $('#place-send').disabled = false;
    if (r.error) return toast(r.error);
    store.set('vote_' + r.id, 1);
    toast('Merci, signalement envoyé', 'ok');
    stopPlacing();
  });

  // Grille des types + légende
  for (const [k, t] of Object.entries(TYPES)) {
    $('#report-types').append(h('button', { class: 'type-btn', style: `--c:${t.color}`, onclick: () => startPlacing(k) },
      h('span', { class: 'e' }, t.emoji), h('span', {}, t.label, h('small', {}, t.sub))));
    $('#legend').append(h('div', { style: `--c:${t.color}` }, h('i'), `${t.emoji} ${t.label}`));
  }
  $('#legend').append(h('div', { style: '--c:#ff4f7b88' }, h('i'), 'Zone de foule'));
  $('#legend').append(h('div', { style: '--c:#3b82f6' }, h('i'), 'Moi'));
  $('#legend').append(h('div', { style: '--c:#7c5cff' }, h('i'), '🛣️ Parcours officiel'));
  $('#legend').append(h('div', { style: '--c:#ff4f7b' }, h('i'), '🚩 Rendez-vous du groupe'));

  // ---------- Manifs ----------
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  function dayLabel(d) {
    const t = today();
    const tomorrow = new Date(Date.parse(t + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    if (d === t) return 'Aujourd’hui';
    if (d === tomorrow) return 'Demain';
    return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const eventWhen = (e) => [dayLabel(e.date), e.time ? 'à ' + e.time : ''].filter(Boolean).join(' ');
  const SOURCES = { demosphere: 'Démosphère', mobilizon: 'Mobilizon', 'paris-luttes': 'Paris-luttes.info', manuel: 'Organisateur·ices' };
  // Lien externe : seulement http(s) (le serveur filtre déjà, on revérifie à l'affichage)
  const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

  function eventPopup(e) {
    const href = safeHref(e.url);
    return h('div', { class: 'pop' },
      h('h4', {}, '✊ ' + e.title),
      h('div', {}, eventWhen(e)),
      e.place || e.city ? h('div', { class: 'meta' }, [e.place, e.city].filter(Boolean).join(' · ')) : null,
      e.approx ? h('div', { class: 'meta warn' }, '⚠️ Lieu approximatif : vérifie auprès de la source') : null,
      e.note ? h('div', { class: 'note' }, e.note) : null,
      h('div', { class: 'meta' }, 'Source : ' + (SOURCES[e.source] || '—')),
      h('div', { class: 'votes' },
        href ? h('a', { class: 'btn small ghost', href, target: '_blank', rel: 'noopener noreferrer' }, 'Source ↗') : null,
        h('a', { class: 'btn small primary', href: walkLink(e), target: '_blank', rel: 'noopener noreferrer' }, '🚶 Y aller')));
  }

  function drawRoutes(events) {
    state.routes = events || [];
    routeLayer.clearLayers();
    const t = today();
    for (const e of state.routes) {
      const popup = () => eventPopup(e);
      if (e.points && e.points.length > 1) {
        L.polyline(e.points, { color: '#000', weight: 11, opacity: 0.35 }).addTo(routeLayer);
        L.polyline(e.points, { color: '#a78bfa', weight: 6, opacity: 0.95, dashArray: '1 10', lineCap: 'round' }).addTo(routeLayer);
        L.polyline(e.points, { color: '#7c5cff', weight: 6, opacity: 0.55 }).bindPopup(popup).addTo(routeLayer);
        L.marker(e.points[e.points.length - 1], { icon: L.divIcon({ className: '', html: '<div class="route-end">🏁</div>', iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 200 }).bindPopup(popup).addTo(routeLayer);
      }
      const later = e.date !== t;
      L.marker([e.lat, e.lng], {
        icon: L.divIcon({ className: '', html: `<div class="event-icon${later ? ' later' : ''}">✊</div>`, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] }),
        zIndexOffset: 250,
      }).bindPopup(popup).addTo(routeLayer);
    }
    const n = state.routes.filter((e) => e.date === t).length;
    $('#events-badge').hidden = n === 0;
    $('#events-badge').textContent = n;
    renderRouteList();
  }

  function focusEvent(e) {
    closeSheets();
    if (e.points && e.points.length > 1) map.fitBounds(e.points, { padding: [40, 40] });
    else map.setView([e.lat, e.lng], 15);
  }

  function eventItem(e, actions, extra) {
    return h('div', { class: 'event-item' + (e.date === today() ? ' today' : '') },
      h('div', { class: 'event-main' },
        h('div', { class: 'event-when' }, eventWhen(e)),
        h('strong', {}, e.title),
        h('div', { class: 'hint', style: 'margin:2px 0 0' }, [e.city, e.place].filter(Boolean).join(' · ').slice(0, 140) + (e.approx ? ' · lieu approximatif' : '')),
        extra ? h('div', { class: 'hint', style: 'margin:2px 0 0' }, extra) : null),
      h('div', { class: 'acts' }, actions));
  }

  function renderRouteList() {
    const list = $('#event-list');
    list.replaceChildren();
    const q = $('#event-filter').value.trim().toLowerCase();
    const shown = state.routes.filter((e) => !q || [e.title, e.city, e.place].join(' ').toLowerCase().includes(q));
    if (!shown.length) list.append(h('p', { class: 'hint' }, q ? 'Aucune manif ne correspond.' : 'Aucune manif publiée pour le moment.'));
    for (const e of shown) {
      const href = safeHref(e.url);
      list.append(eventItem(e, [
        h('button', { class: 'btn small primary', onclick: () => focusEvent(e) }, 'Voir'),
        href ? h('a', { class: 'btn small ghost', href, target: '_blank', rel: 'noopener noreferrer' }, '↗') : null,
      ]));
    }
  }
  $('#event-filter').addEventListener('input', renderRouteList);

  // ----- Espace organisateur·ices -----
  let adminEvents = [];
  let importReport = null;
  // Clé révoquée par un·e responsable : on oublie la clé et on referme l'espace
  socket.on('organizer:revoked', () => {
    state.organizer = false;
    store.set('orgKey', null);
    $('#organizer-form').hidden = false;
    $('#organizer-tools').hidden = true;
    if (!$('#sheet-orga').hidden) closeSheets();
    toast('Ta clé organisateur·ice a été révoquée');
  });
  socket.on('events:admin', (d) => {
    adminEvents = d.events || [];
    importReport = d.report || null;
    renderOrga();
  });
  function renderOrga() {
    const by = (st) => adminEvents.filter((e) => e.status === st);
    const pending = by('pending');
    $('#orga-pending-count').textContent = pending.length ? `(${pending.length})` : '';
    const fill = (el, list, mk) => {
      el.replaceChildren();
      if (!list.length) el.append(h('p', { class: 'hint' }, 'Rien pour le moment.'));
      list.forEach((e) => el.append(mk(e)));
    };
    const common = (e) => [
      safeHref(e.url) ? h('a', { class: 'btn small ghost', href: safeHref(e.url), target: '_blank', rel: 'noopener noreferrer', title: 'Source : ' + (SOURCES[e.source] || '') }, '↗') : null,
      h('button', { class: 'btn small ghost', onclick: () => startDraw(e) }, '✏️'),
    ];
    const status = (e, st) => act('event:status', { id: e.id, status: st });
    // « auto » : publiée sans validation ; sinon, raison pour laquelle elle attend (lieu approximatif…)
    const meta = (e) => [SOURCES[e.source], e.auto ? '🤖 publiée automatiquement' : e.status === 'pending' && e.why ? 'à vérifier : ' + e.why : '', e.by ? 'par ' + e.by : ''].filter(Boolean).join(' · ');
    fill($('#orga-pending'), pending, (e) => eventItem(e, [...common(e),
      h('button', { class: 'btn small ok', onclick: () => status(e, 'published') }, '✓ Publier'),
      h('button', { class: 'btn small no', onclick: () => status(e, 'rejected') }, '✗')], meta(e)));
    fill($('#orga-published'), by('published'), (e) => eventItem(e, [...common(e),
      h('button', { class: 'btn small no', onclick: () => confirmThen(`Retirer « ${e.title} » de la carte ?`, () => status(e, 'pending')) }, 'Retirer')], meta(e)));
    fill($('#orga-rejected'), by('rejected'), (e) => eventItem(e, [...common(e),
      h('button', { class: 'btn small ghost', onclick: () => status(e, 'pending') }, 'Revoir')], meta(e)));
    const r = importReport;
    $('#orga-report').replaceChildren(r
      ? h('div', {}, h('strong', {}, `Dernier import : ${new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`),
        h('div', { class: 'hint', style: 'margin:4px 0' }, r.error ? 'Erreur : ' + r.error : `${r.added} nouvelle(s), ${r.updated} mise(s) à jour, ${r.published || 0} publiée(s) automatiquement`),
        h('ul', { class: 'tips' }, (r.sources || []).map((x) => h('li', {}, x.ok ? `✓ ${x.name} : ${x.kept} manif(s) localisée(s) sur ${x.matched ?? x.kept} repérée(s) (${x.found} évènements lus)` : `✗ ${x.name} : ${x.error}`))))
      : h('p', { class: 'hint', style: 'margin:0' }, 'Import automatique toutes les 2 heures. Aucun import encore cette session.'));
  }

  async function unlockOrganizer(key, silent) {
    const r = await emit('organizer', { key });
    if (r.error) {
      store.set('orgKey', null);
      if (!silent) toast(r.error);
      return;
    }
    store.set('orgKey', key);
    state.organizer = true;
    $('#organizer-form').hidden = true;
    $('#organizer-tools').hidden = false;
    if (!silent) {
      toast('Espace organisateur·ices déverrouillé', 'ok');
      openSheet('orga');
    }
  }
  $('#organizer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlockOrganizer($('#organizer-key').value);
    $('#organizer-key').value = '';
  });
  $('#orga-open').addEventListener('click', () => openSheet('orga'));
  $('#orga-add').addEventListener('click', () => startDraw(null));
  $('#orga-import').addEventListener('click', async () => {
    const r = await act('import:run');
    if (r.ok) toast('Import lancé, les résultats arrivent dans quelques instants', 'ok');
  });
  socket.on('connect', () => { if (state.organizer && store.get('orgKey')) unlockOrganizer(store.get('orgKey'), true); });

  // ----- Création / modification d'une manif (lieu de départ + parcours) -----
  let drawing = null;
  const drawLayer = L.layerGroup().addTo(map);
  function redrawDraft() {
    drawLayer.clearLayers();
    const pts = drawing.points;
    const start = pts[0] || drawing.start;
    if (pts.length > 1) L.polyline(pts, { color: '#7c5cff', weight: 6, opacity: 0.9 }).addTo(drawLayer);
    pts.slice(1).forEach((p) => L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="draw-pt"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }), interactive: false }).addTo(drawLayer));
    if (start) L.marker(start, { icon: L.divIcon({ className: '', html: '<div class="event-icon">✊</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false }).addTo(drawLayer);
    $('#draw-count').textContent = pts.length ? `${pts.length} point${pts.length > 1 ? 's' : ''}` : start ? 'départ placé' : 'aucun point';
  }
  function setDrawFields(open) {
    $('#draw-fields').hidden = !open;
    $('#draw-toggle').textContent = open ? 'Détails ▴' : 'Détails ▾';
    $('#draw-toggle').setAttribute('aria-expanded', String(open));
  }
  function startDraw(e) {
    closeSheets();
    stopPlacing();
    drawing = {
      id: e?.id || null,
      status: e?.status,
      start: e ? [e.lat, e.lng] : null,
      points: e?.points ? e.points.map((p) => [...p]) : [],
    };
    $('#draw-heading').textContent = e ? 'Modifier la manif' : 'Nouvelle manif';
    $('#draw-name').value = e?.title || '';
    $('#draw-date').value = e?.date || today();
    $('#draw-time').value = e?.time || '';
    $('#draw-place').value = e?.place || '';
    $('#draw-note').value = e?.note || '';
    $('#draw-steps').value = '';
    $('#draw-publish').checked = !e || e.status === 'published' || e.status === 'pending';
    setDrawFields(!e);
    $('#draw-bar').hidden = false;
    $('.bottombar').hidden = true;
    map.removeLayer(routeLayer);
    if (e?.points?.length > 1) map.fitBounds(e.points, { padding: [40, 40] });
    else if (e) map.setView([e.lat, e.lng], 16);
    redrawDraft();
  }
  function stopDraw() {
    drawing = null;
    drawLayer.clearLayers();
    $('#draw-bar').hidden = true;
    $('.bottombar').hidden = false;
    if ($('#layer-routes').checked) map.addLayer(routeLayer);
  }
  map.on('click', (e) => {
    if (!drawing) return;
    drawing.points.push([e.latlng.lat, e.latlng.lng]);
    if (drawing.points.length === 1) setDrawFields(false); // libère la carte pour tracer
    redrawDraft();
  });
  $('#draw-toggle').addEventListener('click', () => setDrawFields($('#draw-fields').hidden));
  // Parcours tracé automatiquement à partir des étapes écrites, en suivant les rues
  $('#draw-plan').addEventListener('click', async () => {
    if (!drawing) return;
    const steps = $('#draw-steps').value;
    if (steps.split('\n').filter((x) => x.trim()).length < 2) return toast('Écris au moins le départ et l’arrivée, une étape par ligne');
    const btn = $('#draw-plan');
    btn.disabled = true;
    btn.textContent = '🧭 Tracé en cours…';
    const c = map.getCenter();
    const r = await act('route:plan', { steps, lat: c.lat, lng: c.lng });
    btn.disabled = false;
    btn.textContent = '🧭 Tracer le parcours';
    if (!r.ok || !drawing) return;
    drawing.points = r.points;
    if (!$('#draw-place').value.trim()) $('#draw-place').value = r.steps[0].text;
    setDrawFields(false);
    redrawDraft();
    map.fitBounds(r.points, { padding: [40, 40] });
    toast(r.via === 'droit' ? 'Parcours tracé en lignes droites entre les étapes : vérifie-le' : 'Parcours tracé : vérifie-le puis enregistre', 'ok');
  });
  $('#draw-undo').addEventListener('click', () => { if (drawing) { drawing.points.pop(); redrawDraft(); } });
  $('#draw-cancel').addEventListener('click', stopDraw);
  $('#draw-save').addEventListener('click', async () => {
    if (!drawing) return;
    const pts = drawing.points;
    const start = pts[0] || drawing.start;
    if (!start) return toast('Touche la carte pour placer le lieu de départ');
    const r = await act('event:save', {
      id: drawing.id,
      title: $('#draw-name').value, date: $('#draw-date').value, time: $('#draw-time').value,
      place: $('#draw-place').value, note: $('#draw-note').value,
      lat: start[0], lng: start[1],
      points: pts.length > 1 ? pts : drawing.id && pts.length <= 1 ? [] : null,
      approx: false,
      status: $('#draw-publish').checked ? 'published' : 'pending',
    });
    if (r.ok) {
      toast($('#draw-publish').checked ? 'Manif publiée pour tout le monde' : 'Manif enregistrée (non publiée)', 'ok');
      stopDraw();
      if (state.organizer) openSheet('orga');
    } else setDrawFields(true);
  });

  // ---------- Visite guidée ----------
  // Chaque étape met un bouton en lumière sur fond sombre, explique ce qu'il fait et à quoi il sert.
  const TOUR = [
    { icon: '📍', title: 'Bienvenue sur Manif Friend',
      text: 'La carte en direct des manifs en France, pour rester ensemble et en sécurité. La carte se consulte librement ; pour agir, un simple pseudo et un mot de passe suffisent : ni e-mail, ni numéro.',
      goal: 'Cette visite te montre chaque bouton en une minute.' },
    { target: 'map', icon: '🗺️', title: 'La carte en direct',
      text: 'Les manifs ✊ et les signalements apparaissent ici : 📣 cortège et sa direction, 🚧 rue bloquée, ⛔ nasse, 💨 gaz, ⚠️ violences, ⛑️ medics, 🕊️ zone calme. Touche une icône pour les détails, puis 👍 si c’est toujours vrai ou 👎 si ce n’est plus là.',
      goal: 'Savoir d’un coup d’œil où aller et où éviter.' },
    { target: '#btn-report', icon: '＋', title: 'Signaler',
      text: 'Tu vois quelque chose ? Choisis le type, vise l’endroit sur la carte, ajoute une précision et envoie. C’est anonyme et ça disparaît tout seul après 20 à 60 minutes.',
      goal: 'Prévenir tout le monde en temps réel et éviter les mouvements de panique.' },
    { target: '#btn-share', icon: '📍', title: 'Partager ma position',
      text: 'Désactivé par défaut. Tu choisis : ne pas partager, anonyme (tes groupes voient « membre anonyme ») ou avec ton pseudo. Ta position n’est jamais enregistrée.',
      goal: 'Que tes ami·es te retrouvent, sans que personne d’autre ne te voie.' },
    { target: '#btn-groups', icon: '👥', title: 'Groupes',
      text: 'Crée un groupe pour tes ami·es ou rejoins le leur en scannant leur QR code. Personne n’entre sans l’accord d’un·e admin, qui peut fixer un point de rendez-vous 🚩 visible uniquement par le groupe.',
      goal: 'Vous voir sur la carte entre personnes de confiance et vous retrouver si vous êtes séparé·es.' },
    { target: '#btn-layers', icon: '📅', title: 'Manifs à venir',
      text: 'La liste des manifs partout en France, avec date, heure, lieu de départ et parcours quand il est connu. Elles sont repérées dans les agendas militants puis vérifiées avant publication. Ici aussi : ce qui s’affiche sur la carte, carte sombre et alertes à moins de 400 m.',
      goal: 'Savoir où et quand ça se passe, et choisir ce que tu vois.' },
    { target: '#btn-info', icon: 'ℹ️', title: 'Infos et urgences',
      text: 'Numéros d’urgence (112, 15, 18, SMS 114), conseils en cas de gaz ou de bousculade, vie privée, et installation de l’appli sur l’écran d’accueil.',
      goal: 'Avoir les bons réflexes en cas de problème.' },
    { target: '#btn-locate', icon: '◎', title: 'Me centrer',
      text: 'Recentre la carte sur toi (le point bleu). Il n’est visible que par toi tant que tu ne partages pas ta position.',
      goal: 'Te repérer en un geste.' },
    { target: '.leaflet-control-zoom', icon: '🔍', title: 'Zoom',
      text: 'Zoome pour lire les noms de rues, dézoome pour voir tout le cortège. Tu peux aussi pincer la carte avec deux doigts.',
      goal: 'Passer du détail de ta rue à la vue d’ensemble.' },
    { target: '#share-pill', icon: '🕶️', title: 'Ton état de partage',
      text: 'Indique en permanence si tu partages ta position : « off », « anonyme » ou ton pseudo. Touche-le pour changer.',
      goal: 'Toujours savoir si tu es visible.' },
    { target: '#conn', icon: '🟢', title: 'Connexion',
      text: 'Vert : connecté, les infos arrivent en direct. Rouge : réseau coupé, fréquent en grosse manif. L’appli se reconnecte toute seule et la carte déjà vue reste disponible.',
      goal: 'Savoir si ce que tu vois est à jour.' },
    { target: '.brand', icon: '🗑️', title: 'Effacement d’urgence',
      text: 'Touche 3 fois rapidement le logo : l’appli efface immédiatement ton pseudo, te retire de tes groupes et vide le téléphone, sans confirmation.',
      goal: 'Te protéger, toi et tes ami·es, si ton téléphone est pris.' },
    { icon: '✅', title: 'C’est parti !',
      text: 'Commence par créer ou rejoindre le groupe de tes ami·es. Tu peux revoir cette visite à tout moment dans l’onglet Infos.',
      goal: '', last: true },
  ];
  const tour = {
    active: false,
    i: 0,
    start() {
      closeSheets();
      stopPlacing();
      this.active = true;
      this.i = 0;
      $('#tour').hidden = false;
      $('#tour-dots').replaceChildren(...TOUR.map(() => h('i')));
      this.show();
    },
    end(then) {
      this.active = false;
      $('#tour').hidden = true;
      store.set('welcomed', true);
      if (then) then();
    },
    go(d) {
      const n = this.i + d;
      if (n < 0) return;
      if (n >= TOUR.length) return this.end();
      this.i = n;
      this.show();
    },
    rect(step) {
      if (!step.target) return null;
      if (step.target === 'map') {
        const top = $('.topbar').getBoundingClientRect().bottom + 14;
        const bottom = $('.bottombar').getBoundingClientRect().top - 14;
        return { left: 14, top, width: window.innerWidth - 28, height: bottom - top };
      }
      const el = $(step.target);
      if (!el || !el.getClientRects().length) return null;
      // englobe aussi ce qui dépasse de l'élément (le gros bouton rond « Signaler »)
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (const c of el.querySelectorAll('*')) {
        const b = c.getBoundingClientRect();
        if (!b.width) continue;
        left = Math.min(left, b.left); top = Math.min(top, b.top);
        right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom);
      }
      const pad = 6;
      left = Math.max(2, left - pad); top = Math.max(2, top - pad);
      right = Math.min(window.innerWidth - 2, right + pad); bottom = Math.min(window.innerHeight - 2, bottom + pad);
      return { left, top, width: right - left, height: bottom - top };
    },
    show() {
      const step = TOUR[this.i];
      $('#tour-step').textContent = `Étape ${this.i + 1} sur ${TOUR.length}`;
      $('#tour-icon').textContent = step.icon;
      $('#tour-title').textContent = step.title;
      $('#tour-text').textContent = step.text;
      $('#tour-goal').textContent = step.goal ? '👉 À quoi ça sert : ' + step.goal : '';
      [...$('#tour-dots').children].forEach((d, j) => d.classList.toggle('on', j === this.i));
      $('#tour-prev').hidden = this.i === 0 && !step.last;
      $('#tour-prev').textContent = step.last ? '👥 Mes ami·es' : '← Précédent';
      $('#tour-next').textContent = this.i === 0 ? 'Commencer la visite →' : step.last ? 'Terminer' : 'Suivant →';
      $('#tour-skip').hidden = !!step.last;
      this.place();
      $('#tour-next').focus({ preventScroll: true });
    },
    place() {
      if (!this.active) return;
      const r = this.rect(TOUR[this.i]);
      const hole = $('.tour-hole');
      const card = $('.tour-card');
      const W = window.innerWidth;
      const H = window.innerHeight;
      hole.classList.toggle('none', !r);
      if (r) Object.assign(hole.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      let top;
      let left;
      if (!r) {
        top = (H - ch) / 2;
        left = (W - cw) / 2;
      } else if (r.height > H * 0.5) {
        // grande zone (la carte) : la bulle se pose en bas, par-dessus
        top = r.top + r.height - ch - 12;
        left = (W - cw) / 2;
      } else {
        const below = r.top + r.height / 2 < H / 2;
        top = below ? r.top + r.height + 14 : r.top - ch - 14;
        left = r.left + r.width / 2 - cw / 2;
      }
      card.style.top = Math.round(Math.max(8, Math.min(top, H - ch - 8))) + 'px';
      card.style.left = Math.round(Math.max(12, Math.min(left, W - cw - 12))) + 'px';
    },
  };
  $('#tour-next').addEventListener('click', () => tour.go(1));
  $('#tour-prev').addEventListener('click', () => (TOUR[tour.i].last ? tour.end(() => openSheet('groups')) : tour.go(-1)));
  $('#tour-skip').addEventListener('click', () => tour.end());
  window.addEventListener('resize', () => tour.place());
  document.addEventListener('keydown', (e) => {
    if (!tour.active) return;
    if (e.key === 'Escape') tour.end();
    else if (e.key === 'ArrowRight') tour.go(1);
    else if (e.key === 'ArrowLeft') tour.go(-1);
  });

  // ---------- Panneaux ----------
  const sheets = ['share', 'report', 'groups', 'layers', 'info'];
  const allSheets = [...sheets, 'orga'];
  function openSheet(name) {
    closeSheets();
    $('#sheet-' + name).hidden = false;
    $('#backdrop').hidden = false;
    $('#btn-' + name)?.classList.add('active');
    if (name === 'groups') renderGroups();
    if (name === 'orga') renderOrga();
  }
  function closeSheets() {
    allSheets.forEach((s) => { $('#sheet-' + s).hidden = true; $('#btn-' + s)?.classList.remove('active'); });
    $('#backdrop').hidden = true;
  }
  allSheets.forEach((s) => $('#sheet-' + s).prepend(h('button', { class: 'sheet-close', 'aria-label': 'Fermer', onclick: closeSheets }, '✕')));
  sheets.forEach((s) => $('#btn-' + s).addEventListener('click', () => ($('#sheet-' + s).hidden ? openSheet(s) : closeSheets())));
  $('#backdrop').addEventListener('click', closeSheets);
  $('#open-tour').addEventListener('click', () => tour.start());
  $('#share-pill').addEventListener('click', () => openSheet('share'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); stopPlacing(); if (drawing) stopDraw(); } });

  // Calques
  $('#layer-reports').addEventListener('change', (e) => (e.target.checked ? map.addLayer(reportLayer) : map.removeLayer(reportLayer)));
  $('#layer-density').addEventListener('change', (e) => (e.target.checked ? map.addLayer(densityLayer) : map.removeLayer(densityLayer)));
  $('#layer-groups').addEventListener('change', drawGroups);
  $('#layer-routes').addEventListener('change', (e) => (e.target.checked ? map.addLayer(routeLayer) : map.removeLayer(routeLayer)));
  $('#dark-map').checked = store.get('darkMap', false);
  $('#dark-map').addEventListener('change', (e) => { store.set('darkMap', e.target.checked); setBaseMap(); });
  $('#alerts').checked = state.alerts;
  $('#alerts').addEventListener('change', (e) => { state.alerts = e.target.checked; store.set('alerts', state.alerts); });

  // Effacement des données
  async function wipe() {
    socket.emit('pos:stop');
    await Promise.race([emit('forget'), new Promise((r) => setTimeout(r, 1500))]);
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignoré */ }
    location.replace('/');
  }
  $('#forget').addEventListener('click', () => confirmThen('Supprimer ton compte, quitter tous tes groupes et effacer cet appareil ?', wipe));
  // Effacement d'urgence : toucher 3 fois le logo, sans confirmation
  let taps = [];
  $('.brand').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 1500).concat(now);
    if (taps.length >= 3) { document.body.style.visibility = 'hidden'; wipe(); }
  });

  // ---------- PWA ----------
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
  $('#install').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    $('#install').hidden = true;
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

  // Démarrage (sans accord enregistré, par exemple après un effacement : rien n'est partagé)
  setMode(hasConsent() ? state.mode : 'off');
  if (state.mode === 'off' && navigator.permissions) {
    // Si la permission est déjà accordée, on affiche « moi » sur la carte sans rien partager
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') startWatch(); }).catch(() => {});
  }
})();
