#!/bin/sh
# Télécharge la carte vectorielle de la France métropolitaine et de la Corse (données OpenStreetMap,
# build Protomaps) dans map/carte.pmtiles. Usage : scripts/download-map.sh [fichier_de_sortie]
#   MAP_BBOX    zone (par défaut toute la France ; Paris seul : 2.10,48.70,2.60,49.00)
#   MAP_MAXZOOM niveau de détail : 12 ≈ 1,1 Go, 13 ≈ 2,3 Go, 14 ≈ 4,4 Go pour la France (défaut 14)
#   MAP_MAX_AGE_DAYS : ne retélécharge pas une carte plus récente (défaut 30 ; 0 = toujours)
set -eu

OUT="${1:-map/carte.pmtiles}"
BBOX="${MAP_BBOX:-}"
[ -n "$BBOX" ] || BBOX="-5.3,41.2,9.7,51.2"
MAXZOOM="${MAP_MAXZOOM:-14}"
MAX_AGE="${MAP_MAX_AGE_DAYS:-30}"

if [ "$MAX_AGE" != "0" ] && [ -s "$OUT" ] && [ -n "$(find "$OUT" -mtime -"$MAX_AGE" 2>/dev/null)" ]; then
  echo "Carte déjà présente et récente : $OUT"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Messages visibles aussi comme annotations dans GitHub Actions
say() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::notice::$*"; else echo "$*"; fi; }
die() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$*"; else echo "$*" >&2; fi; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Architecture non prise en charge : $(uname -m)" ;;
esac

if command -v pmtiles >/dev/null 2>&1; then
  PMTILES=pmtiles
else
  RELEASE="$WORK/release.json"
  curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest -o "$RELEASE" \
    || die "API GitHub inaccessible pour go-pmtiles"
  URL=$(grep -o "https://[^\"]*_Linux_${ARCH}\.tar\.gz" "$RELEASE" | head -n 1)
  [ -n "$URL" ] || die "Archive pmtiles introuvable. Fichiers publiés : $(grep -o '"name": *"[^"]*"' "$RELEASE" | tr '\n' ' ' | cut -c1-400)"
  say "Outil : $URL"
  curl -fsSL "$URL" -o "$WORK/pmtiles.tar.gz" || die "Téléchargement de $URL impossible"
  tar -xzf "$WORK/pmtiles.tar.gz" -C "$WORK" || die "Archive pmtiles illisible"
  PMTILES=$(find "$WORK" -type f -name pmtiles | head -n 1)
  [ -n "$PMTILES" ] || die "Exécutable pmtiles absent de l'archive : $(tar -tzf "$WORK/pmtiles.tar.gz" | tr '\n' ' ')"
  chmod +x "$PMTILES"
fi

# Les builds Protomaps sont quotidiens : on prend le plus récent disponible
SOURCE=""
NOW=$(date -u +%s)
for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
  D=$(date -u -d "@$((NOW - i * 86400))" +%Y%m%d)
  CODE=$(curl -s -o /dev/null -r 0-15 -w '%{http_code}' "https://build.protomaps.com/$D.pmtiles" || true)
  if [ "$CODE" = "206" ] || [ "$CODE" = "200" ]; then
    SOURCE="https://build.protomaps.com/$D.pmtiles"
    break
  fi
  TRIED="${TRIED:-}$D:$CODE "
done
[ -n "$SOURCE" ] || die "Aucun build Protomaps récent trouvé ($TRIED)"

mkdir -p "$(dirname "$OUT")"
say "Extraction de $BBOX (zoom max $MAXZOOM) depuis $SOURCE"
"$PMTILES" extract "$SOURCE" "$OUT.tmp" --bbox="$BBOX" --maxzoom="$MAXZOOM" >"$WORK/extract.log" 2>&1 \
  || die "Extraction échouée : $(tail -c 400 "$WORK/extract.log" | tr '\n' ' ')"
mv "$OUT.tmp" "$OUT"
say "Carte prête : $(du -h "$OUT" | cut -f1)"
