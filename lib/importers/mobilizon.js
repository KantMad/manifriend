'use strict';
// Mobilizon : plateforme libre d'évènements, API GraphQL https://<instance>/api
const { isDemo } = require('./filter');
const { fetchText } = require('./http');
const { parisParts } = require('../ical');
const { validLatLng } = require('../util');

const QUERY = `query Recherche($term: String, $beginsOn: DateTime, $page: Int, $limit: Int) {
  searchEvents(term: $term, beginsOn: $beginsOn, page: $page, limit: $limit) {
    total
    elements { uuid title url beginsOn
      physicalAddress { geom description street locality postalCode country }
      tags { title } }
  }
}`;

// « 7.745769;48.583464 » (longitude;latitude)
function parseGeom(g) {
  if (typeof g !== 'string') return null;
  const [a, b] = g.split(/[;,\s]+/).map(Number);
  // ordre toujours longitude;latitude — ne jamais deviner (Bruxelles inversé tomberait près de Lille)
  return validLatLng(b, a) ? { lat: b, lng: a } : null;
}

async function importMobilizon({ instances, terms }, { today, until, now, fetchImpl, pages = 2 }) {
  const events = [];
  const sources = [];
  for (const inst of instances) {
    const seen = new Set();
    const before = events.length;
    let found = 0;
    let matched = 0;
    try {
      for (const term of terms) {
        for (let page = 1; page <= pages; page++) {
          const body = JSON.stringify({ query: QUERY, variables: { term, beginsOn: new Date(now()).toISOString(), page, limit: 100 } });
          const json = JSON.parse(await fetchText(inst.replace(/\/$/, '') + '/api', { fetchImpl, method: 'POST', body, headers: { 'Content-Type': 'application/json' } }));
          if (json.errors) throw new Error(json.errors.map((e) => e.message).join(' ; '));
          const els = (json.data && json.data.searchEvents && json.data.searchEvents.elements) || [];
          found += els.length;
          for (const e of els) {
            if (seen.has(e.uuid)) continue;
            seen.add(e.uuid);
            const a = e.physicalAddress || {};
            const pos = parseGeom(a.geom);
            if (!pos) continue;
            // le rectangle « France » déborde sur les pays voisins : on vérifie le pays quand il est connu
            if (a.country && !/^france$/i.test(a.country.trim())) continue;
            const when = parisParts(Date.parse(e.beginsOn));
            if (when.date < today || when.date > until) continue;
            const tags = (e.tags || []).map((t) => t.title).join(' ');
            if (!isDemo(e.title, tags)) continue;
            matched++;
            events.push({
              source: 'mobilizon', sourceId: e.uuid, title: e.title, date: when.date, time: when.time,
              place: [a.description, a.street].filter(Boolean).join(', '), city: a.locality || '', lat: pos.lat, lng: pos.lng, approx: false, url: e.url,
            });
          }
          if (els.length < 100) break;
        }
      }
      sources.push({ name: `Mobilizon ${new URL(inst).host}`, ok: true, found, matched, kept: events.length - before });
    } catch (err) {
      sources.push({ name: `Mobilizon ${inst}`, ok: false, error: err.message });
    }
  }
  return { events, sources };
}

module.exports = { importMobilizon, parseGeom, QUERY };
