'use strict';
// Pages juridiques : modèles HTML de legal/ remplis avec les variables LEGAL_* (échappées).
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const missing = '<span class="a-completer">[à compléter]</span>';
const field = (v) => (typeof v === 'string' && v.trim() ? esc(v.trim()) : missing);

function legalConfig(env = process.env) {
  return {
    editeur: env.LEGAL_EDITEUR || '',
    directeur: env.LEGAL_DIRECTEUR || '',
    contact: env.LEGAL_CONTACT || '',
    hebergeur: env.LEGAL_HEBERGEUR || '',
    hebergeurAdresse: env.LEGAL_HEBERGEUR_ADRESSE || '',
    date: env.LEGAL_DATE || '17 octobre 2026',
    base: env.LEGAL_BASE || '', // hébergeur de la base de données, s'il est distinct (ex. Neon)
    // Version de test (hébergement gratuit, sans disque) : affiche un avertissement
    test: env.LEGAL_TEST === '1',
  };
}

const OSM_TEXT = "ton téléphone télécharge les images de carte directement depuis ses serveurs, qui voient donc ton adresse IP et la zone affichée (pas ta position GPS). Voir sa <a href=\"https://osmfoundation.org/wiki/Privacy_Policy\" rel=\"noopener noreferrer\">politique de confidentialité</a>.";

function renderLegal(template, cfg, { selfHostedMap, partialMap = false, version }) {
  let carte;
  if (selfHostedMap && !partialMap) carte = '<strong>Aucun service de carte tiers</strong> : la carte est servie par nos propres serveurs.';
  else if (selfHostedMap) carte = '<strong>La fondation OpenStreetMap</strong>, en dehors de la zone couverte par notre propre carte : là, ' + OSM_TEXT;
  else carte = '<strong>La fondation OpenStreetMap</strong>, qui fournit les fonds de carte : ' + OSM_TEXT;
  const avertissement = cfg.test
    ? '<p class="avertissement"><strong>Version de test.</strong> Ces textes n\'ont pas encore été relus par un·e juriste. Sur cet hébergement de test, les groupes et pseudos peuvent être effacés à chaque redémarrage du serveur.</p>'
    : '';
  const values = {
    EDITEUR: field(cfg.editeur),
    DIRECTEUR: field(cfg.directeur),
    CONTACT: field(cfg.contact),
    HEBERGEUR: field(cfg.hebergeur),
    HEBERGEUR_ADRESSE: field(cfg.hebergeurAdresse),
    DATE: field(cfg.date),
    VERSION: esc(version || ''),
    CARTE: carte,
    BASE: cfg.base && cfg.base.trim() ? `<li><strong>L'hébergeur de la base de données</strong> (${esc(cfg.base.trim())}), sous-traitant technique qui conserve les comptes, groupes et manifs (jamais les positions ni les signalements).</li>` : '',
    AVERTISSEMENT: avertissement,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));
}

const PAGES = { '/confidentialite': 'confidentialite.html', '/mentions-legales': 'mentions-legales.html' };
const loadTemplates = (dir = path.join(__dirname, '..', 'legal')) =>
  Object.fromEntries(Object.entries(PAGES).map(([route, f]) => [route, fs.readFileSync(path.join(dir, f), 'utf8')]));

module.exports = { esc, legalConfig, renderLegal, loadTemplates, PAGES };
