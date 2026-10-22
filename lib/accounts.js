'use strict';
// Comptes sans e-mail : pseudo + mot de passe, code de secours pour le mot de passe oublié.
// Le serveur ne garde que des empreintes scrypt (salées) du mot de passe et du code de secours,
// et des empreintes SHA-256 des jetons de session : une copie de la base ne permet pas de se connecter.

const crypto = require('crypto');
const { cleanText, CODE_ALPHABET } = require('./util');

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// Pseudo affiché (3 à 24 caractères, pas seulement des espaces ou de la ponctuation)
function cleanName(v) {
  const n = cleanText(v, 24);
  return n.length >= 3 && /[\p{L}\p{N}]/u.test(n) ? n : '';
}
// Clé d'unicité : « Alice », « alice » et « ALICE » sont le même pseudo
const nameKey = (n) => String(n).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const validPassword = (p) => typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX;

function scrypt(secret, salt, N) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(secret, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashSecret(secret, N = 16384) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(secret), salt, N);
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function verifySecret(secret, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  const key = await scrypt(String(secret), Buffer.from(parts[2], 'base64url'), N);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Code de secours : 16 caractères sans ambiguïté (0/O, 1/I…), affichés en 4 groupes
function recoveryCode() {
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s.match(/.{4}/g).join('-');
}
const normalizeRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);

// Jeton de session : aléatoire, transmis une seule fois à l'appareil ; le serveur n'en garde que l'empreinte
const sessionToken = () => crypto.randomBytes(24).toString('base64url');
const sessionKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

module.exports = {
  PASSWORD_MIN, cleanName, nameKey, validPassword, hashSecret, verifySecret, recoveryCode, normalizeRecovery, sessionToken, sessionKey,
};
