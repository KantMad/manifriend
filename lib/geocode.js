'use strict';
// Géocodage d'adresses françaises par la Géoplateforme de l'IGN (Base Adresse Nationale), avec repli
// sur l'ancienne API adresse. Seul le texte d'un lieu public est envoyé, jamais de donnée personnelle.
// Chaque recherche peut être orientée vers un point (« near ») : un résultat trop loin est rejeté,
// ce qui évite qu'une « place de la République » parte dans une autre ville.

const { validLatLng } = require('./util');
const { dist } = require('../public/utils');

const ENDPOINTS = ['https://data.geopf.fr/geocodage/search', 'https://api-adresse.data.gouv.fr/search/'];

function createGeocoder({ fetchImpl = fetch, delayMs = 120 } = {}) {
  const cache = new Map();
  let last = 0;
  // all : renvoie toutes les propositions acceptables (le choix se fait alors chez l'appelant)
  async function query(q, { near, maxKm = 20, minScore = near ? 0.3 : 0.5, type, index, all = false } = {}) {
    let url = `?limit=5&q=${encodeURIComponent(q)}`;
    if (near) url += `&lat=${near.lat}&lon=${near.lng}`;
    if (type) url += `&type=${type}`;
    // index=poi : lieux nommés de l'IGN (gares, stations, monuments…), propre à la Géoplateforme
    if (index) url += `&index=${index}`;
    for (const base of index ? ENDPOINTS.slice(0, 1) : ENDPOINTS) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      let json;
      try {
        const res = await fetchImpl(base + url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        json = await res.json();
      } catch {
        continue; // service suivant
      }
      const out = [];
      for (const f of (json && json.features) || []) {
        if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
        const [lng, lat] = f.geometry.coordinates;
        const p = f.properties || {};
        if (index === 'poi') {
          if (Array.isArray(p.city)) p.city = p.city[0];
          if (!p.label) p.label = p.toponym || (Array.isArray(p.name) ? p.name[0] : p.name) || '';
        }
        if (!validLatLng(lat, lng) || (p.score || 0) < minScore) continue;
        if (near && dist(near, { lat, lng }) > maxKm * 1000) continue;
        const hit = { lat, lng, label: p.label || '', city: p.city || p.name || '', type: p.type || '', score: p.score };
        if (!all) return hit;
        out.push(hit);
      }
      return all ? out : null;
    }
    return all ? [] : null;
  }
  return async function geocode(q, opts = {}) {
    const text = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text.length < 3) return null;
    const key = JSON.stringify([text.toLowerCase(), opts]);
    if (!cache.has(key)) cache.set(key, await query(text, opts));
    return cache.get(key);
  };
}

module.exports = { createGeocoder };
