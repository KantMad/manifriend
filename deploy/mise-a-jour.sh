#!/bin/bash
# Met Manif Friend à jour depuis la branche main (lancé chaque nuit par manif-friend-maj.timer).
# Ne reconstruit que si le code a changé ; les données et la configuration (.env) sont conservées.
set -euo pipefail
cd "$(dirname "$0")/.."
before=$(git rev-parse HEAD)
git fetch -q origin main
git merge -q --ff-only origin/main
after=$(git rev-parse HEAD)
if [ "$before" != "$after" ] || [ "${1:-}" = "--force" ]; then
  echo "Mise à jour ${before:0:7} → ${after:0:7}"
  docker compose up -d --build --remove-orphans
  docker image prune -f >/dev/null
else
  echo "Déjà à jour (${after:0:7})"
fi
