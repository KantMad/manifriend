'use strict';
// Démosphère : agendas militants locaux, flux iCal https://<id>.demosphere.net/events.ics
const { parseICS } = require('../ical');
const { isDemo } = require('./filter');
const { fetchText } = require('./http');
const { dist } = require('../../public/utils');

const ADDRESS = /\d|\b(rue|place|pl\.|avenue|av\.|bd|boulevard|quai|parvis|square|cours|all[ée]e|esplanade|pont|gare|parc|jardins?|mairie|pr[ée]fecture|h[oô]tel de ville|rond[- ]point|carrefour|m[ée]tro|campus|universit[ée]|lyc[ée]e|port)\b/i;
// Premières lignes qui ne désignent pas une ville
const GENERIC = /^(#?\s*)?(centre|centre-ville|partout|divers|ailleurs|en ligne|internet|france|r[ée]gion|d[ée]partement|tbc|à d[ée]finir)\b/i;
const REGION_KM = 120;
const CITY_KM = 15;

// « Toulouse 31200, \nPlace Micoulaud \nToulouse » -> { city, postcode, district, lines }
function parseLocation(loc) {
  const lines = String(loc || '').split('\n').map((l) => l.replace(/[,;:]\s*$/, '').trim()).filter(Boolean);
  const first = (lines.shift() || '').replace(/^#/, '').trim();
  const postcode = (first.match(/\b\d{5}\b/) || [])[0] || '';
  const district = (first.match(/\b(\d{1,2})(e|er|ème)\b/i) || [])[0] || '';
  const city = first.replace(/\b\d{5}\b/, '').replace(/\b\d{1,2}(e|er|ème)\b/i, '').replace(/\s+/g, ' ').trim();
  return { city, postcode, district, lines, generic: !city || GENERIC.test(first) };
}

// Trouve le lieu de départ ; null si introuvable ou hors de la région de l'agenda
async function locate(loc, { geocode, center, defaultCity }) {
  const p = parseLocation(loc);
  if (/^partout|^en ligne|^internet/i.test(p.city)) return null;
  let cityName = defaultCity;
  let cityPos = center;
  if (!p.generic) {
    const c = await geocode([p.postcode, p.city].filter(Boolean).join(' '), { near: center, maxKm: REGION_KM, type: 'municipality' });
    if (!c) return null;
    cityName = p.city;
    cityPos = c;
  }
  if (!cityPos) return null;
  const place = p.lines.join(', ');
  for (const line of p.lines.filter((l) => ADDRESS.test(l)).slice(0, 3)) {
    const g = await geocode(`${line} ${p.postcode} ${cityName} ${p.district}`, { near: cityPos, maxKm: CITY_KM });
    if (g) return { lat: g.lat, lng: g.lng, approx: false, city: cityName, place };
  }
  return { lat: cityPos.lat, lng: cityPos.lng, approx: true, city: cityName, place };
}

async function importDemosphere(instances, { today, until, geocode, fetchImpl }) {
  const events = [];
  const sources = [];
  for (const inst of instances) {
    const { id, city: defaultCity } = typeof inst === 'string' ? { id: inst, city: '' } : inst;
    const name = `Démosphère ${id}`;
    try {
      const all = parseICS(await fetchText(`https://${id}.demosphere.net/events.ics`, { fetchImpl }));
      const center = defaultCity ? await geocode(defaultCity, { type: 'municipality' }) : null;
      let kept = 0;
      let matched = 0;
      const unlocated = [];
      for (const e of all) {
        if (!e.start || e.start.date < today || e.start.date > until) continue;
        if (!isDemo(e.summary, e.description, e.categories)) continue;
        matched++;
        let where = null;
        if (e.geo && (!center || dist(center, e.geo) < REGION_KM * 1000)) {
          const p = parseLocation(e.location);
          where = { ...e.geo, approx: false, city: p.generic ? defaultCity : p.city, place: p.lines.join(', ') };
        } else {
          where = await locate(e.location, { geocode, center, defaultCity });
        }
        if (!where) {
          if (unlocated.length < 5) unlocated.push(e.summary);
          continue;
        }
        events.push({
          source: 'demosphere', sourceId: e.uid || e.url, title: e.summary, date: e.start.date, time: e.start.time,
          place: where.place, city: where.city, lat: where.lat, lng: where.lng, approx: where.approx, url: e.url,
        });
        kept++;
      }
      sources.push({ name, ok: true, found: all.length, matched, kept, unlocated });
    } catch (err) {
      sources.push({ name, ok: false, error: err.message });
    }
  }
  return { events, sources };
}

module.exports = { importDemosphere, parseLocation, locate };
