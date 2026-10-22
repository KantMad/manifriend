'use strict';
// Import de toutes les sources configurées (config/sources.json)
const path = require('path');
const fs = require('fs');
const { createGeocoder } = require('../geocode');
const { importDemosphere } = require('./demosphere');
const { importMobilizon } = require('./mobilizon');
const { importParisLuttes } = require('./parisluttes');
const { autoPublishDecision } = require('./trust');

function loadConfig(file = process.env.SOURCES_FILE || path.join(__dirname, '..', '..', 'config', 'sources.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function importAll({ today, now = Date.now, fetchImpl = fetch, config = loadConfig(), geocode } = {}) {
  const until = addDays(today, config.daysAhead || 30);
  const ctx = { today, until, now, fetchImpl, geocode: geocode || createGeocoder({ fetchImpl }) };
  const parts = await Promise.all([
    config.demosphere && config.demosphere.length ? importDemosphere(config.demosphere, ctx) : null,
    config.mobilizon ? importMobilizon(config.mobilizon, ctx) : null,
    config.parisLuttes && config.parisLuttes.enabled ? importParisLuttes(config.parisLuttes, ctx) : null,
  ]);
  const events = [];
  const sources = [];
  for (const p of parts.filter(Boolean)) {
    events.push(...p.events);
    sources.push(...p.sources);
  }
  // Publication automatique des manifs sûres (le serveur peut la désactiver : AUTO_PUBLISH=0)
  for (const ev of events) Object.assign(ev, autoPublishDecision(ev, { policy: config.autoPublish, today }));
  return { events, sources };
}

module.exports = { importAll, loadConfig, addDays };
