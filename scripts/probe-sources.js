'use strict';
// Sonde les sources d'agenda (adresses de flux, formats) et le géocodeur.
// Écrit un rapport texte : node scripts/probe-sources.js rapport.txt
const fs = require('fs');

const out = [];
const log = (...a) => out.push(a.join(' '));
const UA = { 'User-Agent': 'ManifFriend-probe/1.0 (+https://github.com/KantMad/manifriend)' };

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctrl.signal, redirect: 'follow' });
    const body = await r.text();
    return { status: r.status, type: r.headers.get('content-type') || '', body, url: r.url };
  } catch (e) {
    return { status: 0, type: '', body: '', error: e.message };
  } finally {
    clearTimeout(t);
  }
}
const short = (s, n = 300) => s.replace(/\s+/g, ' ').slice(0, n);

async function probeSite(name, home, candidates) {
  log(`\n===== ${name} : ${home}`);
  const h = await get(home);
  log(`accueil -> ${h.status} ${h.type} ${h.error || ''} (${h.body.length} o)`);
  const links = new Set();
  for (const m of h.body.matchAll(/<link[^>]+>/gi)) if (/alternate|ical|calendar|rss|atom/i.test(m[0])) links.add('LINK ' + m[0]);
  for (const m of h.body.matchAll(/href="([^"]+)"/gi)) if (/ics|ical|calendar|rss|feed|backend|agenda|export|json/i.test(m[1])) links.add(m[1]);
  log('liens intéressants :');
  [...links].slice(0, 60).forEach((l) => log('  ' + l));
  for (const c of candidates) {
    const u = new URL(c, home).href;
    const r = await get(u);
    const vevents = (r.body.match(/BEGIN:VEVENT/g) || []).length;
    const items = (r.body.match(/<item[\s>]|<entry[\s>]/g) || []).length;
    log(`  ${u} -> ${r.status} ${r.type} ${r.error || ''} VEVENT=${vevents} items=${items} taille=${r.body.length}`);
    if (r.status === 200 && (vevents || items)) log('    début : ' + short(r.body, 1200));
  }
}

(async () => {
  log('Sondage du ' + new Date().toISOString());
  // 4e sondage : ce que le lecteur Paris-luttes extrait de la page en direct
  {
    const { parseAgenda } = require('../lib/importers/parisluttes');
    const { isDemo } = require('../lib/importers/filter');
    const { fetchText } = require('../lib/importers/http');
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    const html = await fetchText(`https://paris-luttes.info/spip.php?page=agenda&date_agenda=${ym}-01`);
    const list = parseAgenda(html, now.getUTCFullYear());
    log(`Paris-luttes en direct : ${list.length} entrées, taille ${html.length}`);
    const heads = [...html.matchAll(/ml-agenda-date-page[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    log('  Titres de jours : ' + heads.join(' / '));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    log('  Entrées à partir d’aujourd’hui (' + today + ') : ' + list.filter((e) => e.date >= today).length);
    for (const e of list.filter((x) => x.date >= today).slice(0, 40)) log(`  ${isDemo(e.title, e.lieu) ? 'OUI' : 'non'} ${e.date} ${e.time} | ${e.title} | ${e.lieu}`);
    const dates = {};
    list.forEach((e) => (dates[e.date] = (dates[e.date] || 0) + 1));
    log('  Répartition par date : ' + JSON.stringify(dates));
    const i = html.indexOf('ml-agenda-date-page');
    log('  HTML autour du 1er jour : ' + short(html.slice(i - 100, i + 600), 700));
  }

  // Mobilizon : API GraphQL
  for (const inst of ['https://mobilizon.fr']) {
    log(`\n===== Mobilizon ${inst}`);
    const q = `query { searchEvents(term: "manifestation", limit: 5) { total elements { id uuid title url beginsOn endsOn physicalAddress { geom description street locality postalCode country } tags { title } } } }`;
    const r = await get(inst + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    log(`api -> ${r.status} ${r.type} ${r.error || ''}`);
    log('  ' + short(r.body, 3000));
    const q2 = `query { searchEvents(term: "", location: "u09t", radius: 30, limit: 3) { total elements { title beginsOn physicalAddress { geom locality } } } }`;
    const r2 = await get(inst + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q2 }) });
    log(`api géo -> ${r2.status} ` + short(r2.body, 1500));
  }
  // Géocodeur national (Base Adresse Nationale)
  log('\n===== Géocodeur BAN');
  for (const q of ['Place de la République, Paris', 'Place Bellecour Lyon', 'Vieux-Port Marseille']) {
    const r = await get('https://api-adresse.data.gouv.fr/search/?limit=1&q=' + encodeURIComponent(q));
    log(`${q} -> ${r.status} ` + short(r.body, 500));
  }
  const r = await get('https://data.geopf.fr/geocodage/search?limit=1&q=' + encodeURIComponent('Place de la Nation Paris'));
  log(`Géoplateforme -> ${r.status} ` + short(r.body, 500));
  fs.writeFileSync(process.argv[2] || 'rapport.txt', out.join('\n') + '\n');
  console.log(out.join('\n'));
})();
