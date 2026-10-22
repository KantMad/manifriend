'use strict';
// Téléchargement borné (taille, durée) des sources configurées — jamais d'adresse fournie par un utilisateur.
const UA = 'ManifFriend/1.0 (agenda des manifestations ; +https://github.com/KantMad/manifriend)';
const MAX = 5 * 1024 * 1024;

async function fetchText(url, { fetchImpl = fetch, method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
  const res = await fetchImpl(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX) throw new Error('réponse trop grosse');
  const text = await res.text();
  if (text.length > MAX) throw new Error('réponse trop grosse');
  return text;
}

module.exports = { fetchText, UA };
