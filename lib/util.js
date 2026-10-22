'use strict';
// Fonctions pures, partagées par le serveur et testées unitairement.

const crypto = require('crypto');

// Zone autorisée : France métropolitaine et Corse (évite les données absurdes)
const BOUNDS = { minLat: 41.2, maxLat: 51.2, minLng: -5.3, maxLng: 9.7 };

const REPORT_TYPES = {
  cortege: { ttl: 20 },
  blocage: { ttl: 45 },
  nasse: { ttl: 30 },
  gaz: { ttl: 30 },
  violence: { ttl: 40 },
  medic: { ttl: 60 },
  calme: { ttl: 30 },
  info: { ttl: 30 },
};

// Lecture d'une clé fournie par un client : jamais via la chaîne de prototypes (__proto__, constructor…)
function own(obj, key) {
  return typeof key === 'string' && obj != null && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validLatLng(lat, lng, b = BOUNDS) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng
  );
}

const isValidTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

function validHeading(h) {
  return typeof h === 'number' && h >= 0 && h < 360 ? Math.round(h) % 360 : null;
}

// Limiteur à fenêtre glissante, en mémoire
function createRateLimiter(now = Date.now) {
  const hits = new Map();
  return {
    limited(key, max, windowMs) {
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      const over = arr.length >= max;
      if (!over) arr.push(t);
      hits.set(key, arr);
      return over;
    },
    // Compte sans consommer (ex. : seuls les échecs comptent)
    count(key, windowMs) {
      const t = now();
      return (hits.get(key) || []).filter((x) => t - x < windowMs).length;
    },
    hit(key) {
      hits.set(key, [...(hits.get(key) || []), now()]);
    },
    prune(maxAgeMs = 3600000) {
      const t = now();
      for (const [k, arr] of hits) if (!arr.some((x) => t - x < maxAgeMs)) hits.delete(k);
    },
    get size() {
      return hits.size;
    },
  };
}

const userIdFromToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 20);
const anonId = (secret, userId, groupId) =>
  'a' + crypto.createHmac('sha256', secret).update(userId + ':' + groupId).digest('hex').slice(0, 10);
const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 200;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const normalizeCode = (c) => cleanText(c, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Comparaison à temps constant ; une clé vide désactive la fonction
function checkKey(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Date AAAA-MM-JJ à Paris
const parisDate = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
// Date UTC AAAA-MM-JJ (activité au jour près)
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Carte de foule : agrège les positions en cellules et masque les cellules de moins de `min` personnes
function densityCells(points, { cellLat = 0.002, cellLng = 0.003, min = 3 } = {}) {
  const cells = new Map();
  for (const p of points) {
    const k = Math.floor(p.lat / cellLat) + ':' + Math.floor(p.lng / cellLng);
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, n] of cells) {
    if (n < min) continue;
    const [i, j] = k.split(':').map(Number);
    out.push({ lat: (i + 0.5) * cellLat, lng: (j + 0.5) * cellLng, n });
  }
  return out;
}

function sanitizeRoutePoints(points, max = 500) {
  if (!Array.isArray(points) || points.length < 2 || points.length > max) return null;
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p)) return null;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!validLatLng(lat, lng)) return null;
    out.push([Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);
  }
  return out;
}

// Lien externe : uniquement http(s), jamais javascript:, data:…
function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return '';
  try {
    const x = new URL(u.trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : '';
  } catch {
    return '';
  }
}

const EVENT_STATUSES = ['pending', 'published', 'rejected'];
const EVENT_SOURCES = ['manuel', 'demosphere', 'mobilizon', 'paris-luttes'];

// Normalise une manif venant d'un organisateur ou d'un importeur. Renvoie { error } ou l'objet propre.
function sanitizeEvent(d, { today }) {
  const title = cleanText(d.title, 120);
  if (!title) return { error: 'Titre requis' };
  if (!isValidDate(d.date)) return { error: 'Date invalide' };
  if (d.date < today) return { error: 'Date passée' };
  const lat = Number(d.lat);
  const lng = Number(d.lng);
  if (!validLatLng(lat, lng)) return { error: 'Lieu de départ hors de France' };
  let points = null;
  if (d.points != null && !(Array.isArray(d.points) && d.points.length === 0)) {
    points = sanitizeRoutePoints(d.points);
    if (!points) return { error: 'Parcours invalide : 2 à 500 points en France' };
  }
  return {
    title,
    date: d.date,
    time: isValidTime(d.time) ? d.time : '',
    place: cleanText(d.place, 200),
    city: cleanText(d.city, 60),
    note: cleanText(d.note, 300),
    url: safeUrl(d.url),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    approx: d.approx === true,
    points,
  };
}

module.exports = {
  safeUrl, sanitizeEvent, EVENT_STATUSES, EVENT_SOURCES,
  BOUNDS, REPORT_TYPES, own, cleanText, validLatLng, isValidTime, isValidDate, validHeading,
  createRateLimiter, userIdFromToken, anonId, validToken, inviteCode, normalizeCode, CODE_ALPHABET,
  checkKey, parisDate, dayOf, densityCells, sanitizeRoutePoints,
};
