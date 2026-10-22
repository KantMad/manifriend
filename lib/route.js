'use strict';
// Tracé automatique d'un parcours à partir d'une liste d'étapes écrites (« place de la République »,
// « Barbès »…) : chaque étape est géocodée, puis un itinéraire piéton les relie en suivant les rues
// (service d'itinéraire de l'IGN, puis OSRM en secours ; à défaut, lignes droites entre les étapes).
// Seuls des noms de lieux publics sont envoyés, jamais de donnée personnelle.

const { validLatLng, cleanText } = require('./util');
const { dist } = require('../public/utils');

const MAX_STEPS = 15;
const MAX_POINTS = 500;
const KM_PENALTY = 0.05; // points de score retirés par kilomètre d'éloignement

// Garde au plus `max` points en conservant le premier et le dernier
function thin(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// Coordonnées GeoJSON [lon, lat] -> [lat, lng] arrondies, toutes en France ; null si invalide
function fromGeoJson(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const out = [];
  for (const c of coords) {
    if (!Array.isArray(c)) return null;
    const lat = Number(c[1]);
    const lng = Number(c[0]);
    if (!validLatLng(lat, lng)) return null;
    out.push([Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);
  }
  return out;
}

const ROUTERS = [
  {
    name: 'ign',
    url(pts) {
      const ll = (p) => `${p.lng},${p.lat}`;
      const mid = pts.slice(1, -1).map(ll).join('|');
      return 'https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=pedestrian&optimization=shortest' +
        `&start=${ll(pts[0])}&end=${ll(pts[pts.length - 1])}` + (mid ? `&intermediates=${encodeURIComponent(mid)}` : '') +
        '&geometryFormat=geojson&getSteps=false';
    },
    coords: (j) => j && j.geometry && j.geometry.coordinates,
  },
  {
    name: 'osrm',
    url: (pts) => `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${pts.map((p) => `${p.lng},${p.lat}`).join(';')}?overview=full&geometries=geojson`,
    coords: (j) => j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates,
  },
];

function createRoutePlanner({ fetchImpl = fetch, geocode, timeoutMs = 15000 } = {}) {
  async function follow(pts) {
    for (const r of ROUTERS) {
      try {
        const res = await fetchImpl(r.url(pts), { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) continue;
        const line = fromGeoJson(r.coords(await res.json()));
        if (line) return { points: thin(line), via: r.name };
      } catch {
        // service suivant
      }
    }
    return { points: pts.map((p) => [p.lat, p.lng]), via: 'droit' };
  }

  // steps : texte (une étape par ligne) ou liste ; near : centre de la carte, pour situer la première étape
  return async function plan(steps, { near } = {}) {
    const list = (Array.isArray(steps) ? steps : String(steps || '').split(/\n|;|→|->/))
      .map((s) => cleanText(s, 120)).filter((s) => s.length >= 3);
    if (list.length < 2) return { error: 'Indique au moins un départ et une arrivée, une étape par ligne' };
    if (list.length > MAX_STEPS) return { error: `${MAX_STEPS} étapes au maximum` };
    const found = [];
    let ref = near && validLatLng(near.lat, near.lng) ? near : null;
    for (const text of list) {
      // Plusieurs propositions (adresses, même nom dans la ville de l'étape précédente, lieux nommés de l'IGN
      // comme les gares) ; on garde la mieux notée en pénalisant l'éloignement de l'étape précédente
      // (ou du centre de la carte pour le départ) : « République » à Paris plutôt qu'à Montreuil.
      const opts = ref ? { near: ref, maxKm: found.length ? 8 : 30, all: true } : { all: true };
      const city = found.length && typeof ref.city === 'string' ? ref.city : '';
      const lists = [await geocode(text, opts), await geocode(text, { ...opts, index: 'poi' })];
      if (city && !text.toLowerCase().includes(city.toLowerCase())) lists.push(await geocode(`${text}, ${city}`, opts));
      const candidates = lists.flat().filter(Boolean);
      if (!candidates.length) return { error: `Lieu introuvable : « ${text} ». Essaie un nom de rue ou de place.`, missing: text };
      const rank = (c) => (c.score || 0) - (ref ? (KM_PENALTY * dist(ref, c)) / 1000 : 0);
      const g = candidates.reduce((best, c) => (rank(c) > rank(best) ? c : best));
      found.push({ text, lat: g.lat, lng: g.lng, label: g.label });
      ref = g;
    }
    const { points, via } = await follow(found);
    return { points, via, steps: found.map(({ text, label }) => ({ text, label })) };
  };
}

module.exports = { createRoutePlanner, thin, fromGeoJson };
