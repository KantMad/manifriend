#!/bin/sh
# Sauvegarde quotidienne de la base (groupes, pseudos, manifs) et des clés organisateur·ices.
# Les positions et signalements ne sont jamais écrits sur disque : il n'y a rien d'autre à sauvegarder.
# Conservation : SAUVEGARDE_JOURS jours (14 par défaut), car ces fichiers sont sensibles.
set -eu
SRC=/data
DEST=/sauvegardes
KEEP="${SAUVEGARDE_JOURS:-14}"
umask 077
mkdir -p "$DEST"
while true; do
  d=$(date -u +%Y-%m-%d)
  for f in db.json organizers.json; do
    [ -s "$SRC/$f" ] && cp "$SRC/$f" "$DEST/${f%.json}-$d.json"
  done
  find "$DEST" -name '*.json' -type f -mtime +"$KEEP" -delete
  echo "sauvegarde $d ok"
  [ "${SAUVEGARDE_UNE_FOIS:-0}" = "1" ] && exit 0
  sleep 86400
done
