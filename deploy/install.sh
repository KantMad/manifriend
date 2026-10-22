#!/bin/bash
# Installation complète de Manif Friend sur un serveur neuf (Ubuntu 22.04/24.04 ou Debian 12), en une commande :
#   curl -fsSL https://raw.githubusercontent.com/KantMad/manifriend/main/deploy/install.sh -o install.sh
#   sudo bash install.sh www.manifriend.com
# Installe Docker, le pare-feu, les mises à jour de sécurité automatiques, l'appli (HTTPS par Caddy,
# carte de France, sauvegardes quotidiennes) et sa mise à jour automatique chaque nuit.
# Relancer le script est sans danger : il ne remplace ni les secrets ni les données.
set -euo pipefail

DOMAIN="${1:-}"
DIR=/opt/manif-friend
REPO_HTTPS="${REPO_URL:-https://github.com/KantMad/manifriend.git}"
REPO_SSH="git@github.com:KantMad/manifriend.git"

say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
# Question posée au clavier ; sans terminal (installation automatisée), réponse vide
ask() {
  local v=''
  if { : > /dev/tty; } 2>/dev/null; then printf '%s' "$1" > /dev/tty; IFS= read -r v < /dev/tty || true; fi
  printf '%s' "$v"
}
# Valeur d'une variable d'environnement si elle est fournie, sinon question
ask_or_env() { if [ -n "${!2:-}" ]; then printf '%s' "${!2}"; else ask "$1"; fi; }

[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo : sudo bash install.sh $DOMAIN"; exit 1; }
[ -n "$DOMAIN" ] || DOMAIN=$(ask "Nom de domaine principal (ex. www.manifriend.com) : ")
DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*##')
[ -n "$DOMAIN" ] || { echo "Domaine manquant"; exit 1; }
# www.exemple.com : exemple.com redirige vers www (et inversement)
case "$DOMAIN" in www.*) ALIAS="${DOMAIN#www.}" ;; *) ALIAS="www.$DOMAIN" ;; esac

say "1/8 Mises à jour du système et outils"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl ufw fail2ban unattended-upgrades >/dev/null
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true

say "2/8 Docker"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null

say "3/8 Pare-feu (SSH, HTTP, HTTPS uniquement)"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

# Petite machine : de la mémoire d'appoint pour construire l'image et extraire la carte
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && ! swapon --show | grep -q .; then
  say "Ajout de 2 Go de mémoire d'échange"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "4/8 Code de l'application"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull -q --ff-only
elif ! git clone -q "$REPO_HTTPS" "$DIR" 2>/dev/null; then
  # Dépôt privé : clé de lecture seule propre à ce serveur (« deploy key » GitHub)
  KEY=/root/.ssh/manif_friend_deploy
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "serveur manif-friend" -f "$KEY"
  grep -q 'manif_friend_deploy' /root/.ssh/config 2>/dev/null || printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> /root/.ssh/config
  ssh-keyscan -q github.com >> /root/.ssh/known_hosts 2>/dev/null
  warn "Le dépôt GitHub est privé. Ajoute cette clé dans GitHub : dépôt → Settings → Deploy keys → Add deploy key"
  warn "(titre : serveur, NE PAS cocher « Allow write access ») :"
  echo; cat "$KEY.pub"; echo
  ask "Appuie sur Entrée une fois la clé ajoutée… " >/dev/null || true
  git clone -q "$REPO_SSH" "$DIR"
fi
cd "$DIR"

say "5/8 Configuration (.env)"
if [ ! -f .env ]; then
  ADMIN_KEY=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)
  echo "Pour les mentions légales (Entrée pour remplir plus tard dans $DIR/.env) :"
  EDITEUR=$(ask_or_env "  Éditeur (personne ou collectif qui publie le site) : " LEGAL_EDITEUR)
  DIRECTEUR=$(ask_or_env "  Directeur·ice de la publication : " LEGAL_DIRECTEUR)
  CONTACT=$(ask_or_env "  E-mail de contact : " LEGAL_CONTACT)
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
EXTRA_DOMAINS=$ALIAS
ADMIN_KEY=$ADMIN_KEY
SERVER_SECRET=$(openssl rand -hex 32)
MAP_MAXZOOM=14
LEGAL_EDITEUR=$EDITEUR
LEGAL_DIRECTEUR=$DIRECTEUR
LEGAL_CONTACT=$CONTACT
LEGAL_HEBERGEUR=OVH SAS
LEGAL_HEBERGEUR_ADRESSE=2 rue Kellermann, 59100 Roubaix, France
LEGAL_DATE=$(LC_ALL=C date +%d/%m/%Y)
LEGAL_TEST=0
${MAP_BBOX:+MAP_BBOX=$MAP_BBOX}
ENV
  umask 022
else
  echo "Fichier .env déjà présent : conservé."
fi
chmod 600 .env  # secrets : lisible par root seulement

say "6/8 Vérification du nom de domaine"
IP=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)
for d in "$DOMAIN" "$ALIAS"; do
  got=$(getent ahostsv4 "$d" | awk 'NR==1 {print $1}' || true)
  if [ -n "$IP" ] && [ "$got" = "$IP" ]; then echo "✓ $d → $IP"
  else warn "$d pointe vers « ${got:-rien} » au lieu de $IP : créer un enregistrement A « $d → $IP » chez le registraire. Le certificat HTTPS sera obtenu tout seul dès que ce sera fait."; fi
done

say "7/8 Démarrage (construction de l'image : quelques minutes)"
docker compose build -q app
# Reprise des comptes, groupes et manifs de la version de test (Neon), une seule fois
if [ ! -f .base-importee ]; then
  SRC=$(ask_or_env "Adresse de la base Neon à reprendre (postgresql://…, Entrée pour partir de zéro) : " SOURCE_DATABASE_URL)
  if [ -n "$SRC" ]; then
    if docker compose run --rm --no-deps -e SOURCE_DATABASE_URL="$SRC" app node scripts/import-db.js /data/db.json; then touch .base-importee
    else warn "Reprise de la base impossible (adresse incorrecte ?) : le site démarre à vide. Relancer le script pour réessayer."; fi
  fi
fi
docker compose up -d
echo -n "Attente de l'appli "
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = healthy ] && break
  echo -n "."; sleep 3
done
echo

say "8/8 Mise à jour automatique chaque nuit"
cat > /etc/systemd/system/manif-friend-maj.service <<UNIT
[Unit]
Description=Mise à jour de Manif Friend
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash $DIR/deploy/mise-a-jour.sh
UNIT
cat > /etc/systemd/system/manif-friend-maj.timer <<UNIT
[Unit]
Description=Mise à jour nocturne de Manif Friend
[Timer]
OnCalendar=*-*-* 04:30
RandomizedDelaySec=20m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now manif-friend-maj.timer >/dev/null

ADMIN=$(grep '^ADMIN_KEY=' .env | cut -d= -f2-)
cat <<FIN

──────────────────────────────────────────────────────────────
 ✅ Manif Friend est installé : https://$DOMAIN
    (le certificat HTTPS arrive en 1 à 2 minutes une fois le domaine pointé)

 🔑 Clé organisateur·ices principale : $ADMIN
    (à garder secrète ; aussi dans $DIR/.env)

 La carte de France se télécharge en arrière-plan (environ 10 minutes).
 Sauvegarde quotidienne : $DIR/sauvegardes · mise à jour : chaque nuit vers 4 h 30
 Mettre à jour tout de suite : sudo bash $DIR/deploy/mise-a-jour.sh
──────────────────────────────────────────────────────────────
FIN
