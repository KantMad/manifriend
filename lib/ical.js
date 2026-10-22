'use strict';
// Lecteur iCalendar (RFC 5545) minimal : évènements, dates, texte échappé.

// Lignes « repliées » : une ligne commençant par un espace ou une tabulation continue la précédente
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\([\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// « DTSTART;TZID=Europe/Paris:20261017T140000 » -> { name, params, value }
function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...rest] = head.split(';');
  const params = {};
  for (const p of rest) {
    const j = p.indexOf('=');
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// Date et heure locales à Paris d'un instant UTC
function parisParts(ms) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Valeur DTSTART -> { date: 'AAAA-MM-JJ', time: 'HH:MM' | '' } en heure de Paris
function parseDate(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || prop.params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: '' } : null;
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    const p = parisParts(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    // minuit pile = évènement « journée entière » exporté avec une heure : heure inconnue
    return p.time === '00:00' ? { date: p.date, time: '' } : p;
  }
  // heure « flottante » ou TZID : on la considère comme l'heure de Paris (agendas français)
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

function parseICS(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split('\n')) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (['SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'UID', 'CATEGORIES', 'STATUS'].includes(p.name)) cur[p.name.toLowerCase()] = unescapeText(p.value);
    else if (p.name === 'DTSTART') cur.start = parseDate(p);
    else if (p.name === 'GEO') {
      const [lat, lng] = p.value.split(/[;,]/).map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) cur.geo = { lat, lng };
    }
  }
  return events;
}

module.exports = { parseICS, unfold, unescapeText, parseLine, parseDate, parisParts };
