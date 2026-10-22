'use strict';
// Clés des organisateur·ices : une clé par personne, révocable à tout moment sans redémarrer.
// Seule l'empreinte SHA-256 de chaque clé est stockée (data/organizers.json) ; la clé n'est montrée qu'à sa création.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const NAME = /^[\p{L}\p{N} ._'-]{1,40}$/u;

function createOrganizers({ dataDir, mainKey = '' }) {
  const file = path.join(dataDir, 'organizers.json');
  // Signature du fichier : date + taille + inode (chaque écriture remplace le fichier, donc change d'inode)
  let cache = { sig: '', keys: [] };

  function load() {
    try {
      const st = fs.statSync(file);
      const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (sig !== cache.sig) {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache = { sig, keys: Array.isArray(json.keys) ? json.keys.filter((k) => k && typeof k.hash === 'string' && typeof k.name === 'string') : [] };
      }
    } catch {
      cache = { sig: '', keys: [] };
    }
    return cache.keys;
  }
  function write(keys) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache.sig = '';
  }

  return {
    // Renvoie le nom associé à la clé, ou null
    verify(key) {
      if (typeof key !== 'string' || key.length < 8 || key.length > 200) return null;
      const h = Buffer.from(hash(key), 'hex');
      let found = null;
      // comparaison à temps constant sur toutes les clés
      if (mainKey && crypto.timingSafeEqual(h, Buffer.from(hash(mainKey), 'hex'))) found = 'principal';
      for (const k of load()) if (crypto.timingSafeEqual(h, Buffer.from(k.hash, 'hex')) && !found) found = k.name;
      return found;
    },
    isValid(name) {
      if (!name) return false;
      if (name === 'principal') return !!mainKey;
      return load().some((k) => k.name === name);
    },
    enabled() {
      return !!mainKey || load().length > 0;
    },
    list() {
      return load().map((k) => ({ name: k.name, createdAt: k.createdAt }));
    },
    add(name) {
      if (!NAME.test(String(name || '')) || name === 'principal') throw new Error('Nom invalide (1 à 40 lettres, chiffres, espaces)');
      const keys = load();
      if (keys.some((k) => k.name === name)) throw new Error(`« ${name} » a déjà une clé : la révoquer d'abord`);
      const key = crypto.randomBytes(18).toString('base64url');
      write([...keys, { name, hash: hash(key), createdAt: new Date().toISOString() }]);
      return key;
    },
    remove(name) {
      const keys = load();
      if (!keys.some((k) => k.name === name)) return false;
      write(keys.filter((k) => k.name !== name));
      return true;
    },
  };
}

module.exports = { createOrganizers };
