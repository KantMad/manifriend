/* Manif Friend — fonctions pures du client (aussi testées sous Node) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MF = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const GROUP_COLORS = ['#ff4f7b', '#22d3ee', '#a3e635', '#f59e0b', '#c084fc', '#34d399', '#fb7185', '#60a5fa'];
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

  function ago(ts, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `il y a ${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`;
  }

  // Distance en mètres (formule de haversine)
  function dist(a, b) {
    const R = 6371000;
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLng = (b.lng - a.lng) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

  function colorFor(id) {
    let x = 0;
    for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return GROUP_COLORS[x % GROUP_COLORS.length];
  }

  const headingLabel = (deg) => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  // Initiales affichées sur le marqueur d'un membre
  const initials = (nickname) => (nickname ? Array.from(nickname.trim()).slice(0, 2).join('').toUpperCase() || '?' : '?');

  // Jeton aléatoire de 32 caractères (base64url), créé une fois par appareil
  function makeToken(getRandomValues) {
    const b = new Uint8Array(24);
    getRandomValues(b);
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
  }

  function inviteLink(origin, code) {
    return `${origin}/?join=${encodeURIComponent(code)}`;
  }

  // Code d'invitation lu dans l'URL (?join=…), nettoyé
  function joinCodeFromSearch(search) {
    const raw = new URLSearchParams(search).get('join');
    if (!raw) return null;
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return code || null;
  }

  return { GROUP_COLORS, DIRS, ago, dist, fmtDist, colorFor, headingLabel, initials, makeToken, inviteLink, joinCodeFromSearch };
});
