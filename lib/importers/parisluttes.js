'use strict';
// Paris-luttes.info : l'agenda n'existe qu'en page web (une page par mois) — lecture de sa structure HTML.
const { isDemo } = require('./filter');
const { fetchText } = require('./http');

const BASE = 'https://paris-luttes.info/';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
}
const text = (html) => decodeEntities(String(html).replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

// « Aujourd'hui (samedi 17 octobre) » / « dimanche 18 octobre » -> AAAA-MM-JJ (année de la page)
function headingDate(h, year) {
  const m = decodeEntities(h).toLowerCase().match(/(\d{1,2})(?:er)?\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)/);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '') === m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function parseAgenda(html, year) {
  const out = [];
  const days = String(html).split(/<div class="ml-agenda-date-page[^"]*">/).slice(1);
  for (const day of days) {
    const date = headingDate(day.slice(0, day.indexOf('<')), year);
    if (!date) continue;
    for (const panel of day.split(/<div class="panel panel-default/).slice(1)) {
      const start = (panel.match(/ml-agenda-date-debut">\s*([^<]*)</) || [])[1] || '';
      const time = (start.match(/\b([01]\d|2[0-3])[:h]([0-5]\d)\b/) || []).slice(1, 3).join(':');
      const href = (panel.match(/<a href="([a-z0-9-]+-\d+)"/i) || [])[1];
      // titre en <h5> (jours passés) ou <h3 class='h5'> (jours à venir)
      const title = text((panel.match(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/) || [])[2] || '').join(' ').replace(/\s*\(en cours\)\s*$/, '');
      const lieu = text((panel.match(/<span class="lieu">([\s\S]*?)<\/span>/) || [])[1] || '').join(' ');
      const address = text((panel.match(/<p><i>([\s\S]*?)<\/i>/) || [])[1] || '');
      if (!href || !title) continue;
      out.push({ date, time, href, title, lieu, address });
    }
  }
  return out;
}

const PARIS = { lat: 48.8566, lng: 2.3522 };
async function locate(e, geocode) {
  const addr = e.address.filter((l) => !/^M(°|étro)/i.test(l));
  if (addr.length) {
    const hasCity = addr.some((l) => /\b\d{5}\b|paris|montreuil|saint-denis|ivry|pantin|bagnolet|aubervilliers|nanterre/i.test(l));
    const g = await geocode(addr.join(' ') + (hasCity ? '' : ' Paris'), { near: PARIS, maxKm: 30 });
    if (g) return { ...g, approx: false };
  }
  // seulement un nom de lieu (« République », « Stalingrad ») : on cherche autour de Paris
  for (const q of [`${e.lieu} Paris`, `place ${e.lieu} Paris`]) {
    if (!e.lieu) break;
    const g = await geocode(q, { near: PARIS, maxKm: 25 });
    if (g) return { ...g, approx: true };
  }
  return null;
}

async function importParisLuttes({ months = 2 }, { today, until, geocode, fetchImpl }) {
  const events = [];
  try {
    let found = 0;
    let matched = 0;
    const unlocated = [];
    const [y, m] = today.split('-').map(Number);
    for (let k = 0; k < months; k++) {
      const year = y + Math.floor((m - 1 + k) / 12);
      const month = ((m - 1 + k) % 12) + 1;
      const html = await fetchText(`${BASE}spip.php?page=agenda&date_agenda=${year}-${String(month).padStart(2, '0')}-01`, { fetchImpl });
      const list = parseAgenda(html, year);
      found += list.length;
      for (const e of list) {
        if (e.date < today || e.date > until) continue;
        if (!isDemo(e.title, e.lieu)) continue;
        matched++;
        const where = await locate(e, geocode);
        if (!where) {
          if (unlocated.length < 5) unlocated.push(`${e.title} (${e.lieu})`);
          continue;
        }
        events.push({
          source: 'paris-luttes', sourceId: `${e.href}|${e.date}|${e.time}|${e.title}`.slice(0, 300), title: e.title, date: e.date, time: e.time,
          place: [e.lieu, ...e.address].filter(Boolean).join(', '), city: where.city || 'Paris', lat: where.lat, lng: where.lng, approx: where.approx, url: BASE + e.href,
        });
      }
    }
    return { events, sources: [{ name: 'Paris-luttes.info', ok: true, found, matched, kept: events.length, unlocated }] };
  } catch (err) {
    return { events, sources: [{ name: 'Paris-luttes.info', ok: false, error: err.message }] };
  }
}

module.exports = { importParisLuttes, parseAgenda, headingDate, decodeEntities };
