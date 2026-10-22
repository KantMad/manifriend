# Mettre Manif Friend en ligne

## Version de test gratuite (Render)

Pour tester avec quelques personnes, sans serveur ni nom de domaine. Compter 5 minutes.

1. Créer un compte sur [render.com](https://render.com) (avec le compte GitHub, c'est le plus simple). Aucune carte bancaire n'est demandée pour l'offre gratuite.
2. Cliquer sur le bouton **Deploy to Render** du README, ou ouvrir <https://render.com/deploy?repo=https://github.com/KantMad/manifriend>.
3. Render lit `render.yaml` et demande trois valeurs, affichées dans les mentions légales :
   - `LEGAL_EDITEUR` : nom de la personne ou du collectif qui publie le site ;
   - `LEGAL_DIRECTEUR` : directeur·ice de la publication ;
   - `LEGAL_CONTACT` : une adresse e-mail de contact (une adresse dédiée, pas l'adresse personnelle).
4. Cliquer sur **Deploy Blueprint**. Le premier déploiement prend 5 à 10 minutes (téléchargement de la carte d'Île-de-France compris). L'adresse ressemble à `https://manif-friend-xxxx.onrender.com` : HTTPS est fourni, donc la géolocalisation et l'installation en PWA fonctionnent.
5. Pour l'espace organisateur·ices : dans Render, ouvrir le service, puis **Environment**, et copier la valeur de `ADMIN_KEY`. La donner seulement aux organisateur·ices.
6. Vérifier : `https://…onrender.com/healthz` répond `{"ok":true}`, puis ouvrir le site sur deux téléphones.

Chaque commit sur `main` redéploie automatiquement le site.

### Garder les comptes : base gratuite Neon (5 minutes)

Render gratuit n'a pas de disque : sans base de données, comptes, groupes et manifs sont effacés à chaque mise à jour ou redémarrage. Neon offre une base Postgres gratuite (0,5 Go, sans carte bancaire), hébergée à Francfort.

1. Créer un compte sur [neon.tech](https://neon.tech) (« Sign up with GitHub »).
2. **Create project** : nom `manif-friend`, région **AWS Europe Central 1 (Frankfurt)**, puis **Create**.
3. Sur la page du projet, bouton **Connect** : copier la **connection string** (elle commence par `postgresql://` et finit par `?sslmode=require`).
4. Dans Render : service **manif-friend** → **Environment** → **Add Environment Variable** : clé `DATABASE_URL`, valeur = l'adresse copiée → **Save, rebuild and deploy**.
5. Vérifier dans **Logs** la ligne `Base postgres chargée`.

L'appli crée seule sa table (`manif_friend_state`). Elle n'y écrit jamais les positions ni les signalements, seulement les comptes (empreintes des mots de passe), les groupes et les manifs. Neon met la base en veille sans activité ; elle se réveille en moins d'une seconde.

**Limites de cette version de test**

| Limite | Conséquence |
| --- | --- |
| Mise en veille après 15 min sans visite | La première ouverture peut prendre jusqu'à 1 minute. Tant que des téléphones sont connectés, le site reste éveillé. |
| Pas de disque | Sans `DATABASE_URL`, comptes, groupes et manifs validées sont **effacés à chaque redémarrage ou redéploiement** : ajouter la base Neon ci-dessus. Les signalements et positions ne sont de toute façon qu'en mémoire. |
| Carte auto-hébergée limitée à l'Île-de-France | La carte de toute la France fait plusieurs Go : seule l'Île-de-France (environ 290 Mo) est intégrée à l'image (`Dockerfile.render`). Ailleurs, la carte vient des serveurs d'OpenStreetMap, ce que la politique de confidentialité signale automatiquement. Leur usage est limité : correct pour un test, pas pour une grosse manif. Pour une autre région, changer `MAP_BBOX` dans `Dockerfile.render`. |
| Petite machine (0,1 processeur, 512 Mo) | Suffisant pour quelques dizaines de personnes, pas pour des milliers. |
| Pas de clés organisateur individuelles | Sans disque ni terminal, seule la clé principale `ADMIN_KEY` est utilisable. |
| Render est une société américaine | Même avec des serveurs à Francfort, elle est soumise au droit américain. Pour une vraie manif, passer sur un hébergeur européen ou associatif (ci-dessous). |

Les pages `/confidentialite` et `/mentions-legales` affichent en rouge « [à compléter] » pour chaque valeur manquante, et un avertissement « Version de test » tant que `LEGAL_TEST=1`. **Faire relire ces textes par un·e juriste** (par exemple via une association de défense des libertés numériques) avant une utilisation réelle.

## Version définitive : serveur OVH + nom de domaine (ex. www.manifriend.com)

Il faut un petit serveur (VPS) avec **au moins 2 Go de RAM et 40 Go de disque** (la carte de France fait 4,4 Go) et un nom de domaine. Chez OVHcloud, l'offre VPS d'entrée de gamme suffit pour des milliers de personnes connectées (voir « Capacité »). Choisir un datacenter **en France** (Gravelines, Strasbourg ou Roubaix) : société et serveurs soumis au droit français.

### 1. Commander le domaine et le serveur

1. Sur [ovhcloud.com](https://www.ovhcloud.com/fr/), commander le nom de domaine (ex. `manifriend.com`). Garder la zone DNS chez OVH (proposé par défaut).
2. Commander un **VPS**, système **Ubuntu 24.04**, datacenter en France. OVH envoie par e-mail l'**adresse IP** du serveur, l'utilisateur (`ubuntu`) et son mot de passe.

### 2. Pointer le domaine vers le serveur

Espace client OVH → **Noms de domaine** → le domaine → **Zone DNS** :
- modifier (ou ajouter) l'enregistrement **A** du domaine sans sous-domaine (`manifriend.com`) → IP du serveur ;
- modifier (ou ajouter) l'enregistrement **A** de `www` → IP du serveur ;
- supprimer d'éventuels enregistrements **AAAA** qui pointeraient ailleurs.

La prise en compte prend de quelques minutes à quelques heures.

### 3. Installer, en une commande

Se connecter au serveur : depuis un ordinateur, `ssh ubuntu@IP_DU_SERVEUR` ; depuis un téléphone, l'appli gratuite **Termius** (nouvel hôte : IP, utilisateur `ubuntu`, mot de passe reçu). Puis :

```bash
curl -fsSL https://raw.githubusercontent.com/KantMad/manifriend/main/deploy/install.sh -o install.sh
sudo bash install.sh www.manifriend.com
```

Le script installe tout (Docker, pare-feu, mises à jour de sécurité automatiques, protection contre les attaques par mot de passe, HTTPS, carte de France, sauvegardes quotidiennes, mise à jour automatique de l'appli chaque nuit). Il pose trois questions pour les mentions légales, puis propose de **reprendre les comptes, groupes et manifs de la version de test** : coller l'adresse de la base Neon (`postgresql://…`), ou Entrée pour partir de zéro. À la fin, il affiche l'adresse du site et la **clé organisateur·ices**.

Dépôt GitHub privé : le script affiche une clé à ajouter dans GitHub (dépôt → *Settings* → *Deploy keys* → *Add deploy key*, sans cocher *Allow write access*), puis continue. Le relancer plus tard est sans danger (secrets et données conservés).

### 4. Après l'installation

- Vérifier : `https://www.manifriend.com` s'ouvre avec le cadenas, `https://manifriend.com` redirige vers `www`.
- Alerte si le site tombe : variable GitHub `SITE_URL` = `https://www.manifriend.com` (voir « Surveillance »).
- Une fois les données reprises et le nouveau site vérifié, la version de test (Render et Neon) peut être supprimée : les comptes vivent maintenant sur le serveur.

### Installation manuelle (autre hébergeur)

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/KantMad/manifriend.git && cd manifriend
cp .env.example .env && nano .env   # DOMAIN, EXTRA_DOMAINS, ADMIN_KEY, SERVER_SECRET (openssl rand -hex 32), LEGAL_*
docker compose up -d --build
```

Caddy obtient le certificat HTTPS tout seul en une minute. Au premier démarrage, le service `carte` télécharge la carte de France (≈ 4,4 Go, quelques minutes) ; l'appli fonctionne déjà pendant ce temps avec les tuiles OpenStreetMap et bascule seule sur la carte auto-hébergée. Les manifs sont importées automatiquement 30 secondes après le démarrage, puis toutes les 2 heures.

Vérifier ensuite que tout fonctionne (depuis n'importe quel ordinateur avec Node.js) :

```bash
node scripts/smoke-test.js https://www.manifriend.com --expect-map --key <ADMIN_KEY>
```

## Clés des organisateur·ices

Une clé par personne, révocable à tout moment sans redémarrer (y compris pour une session ouverte) :

```bash
docker compose exec app node scripts/organizers.js add "Camille"     # affiche la clé une seule fois
docker compose exec app node scripts/organizers.js list
docker compose exec app node scripts/organizers.js remove "Camille"  # révocation immédiate
```

Seule l'empreinte des clés est stockée. L'espace organisateur·ices indique qui a publié chaque manif. `ADMIN_KEY` reste une clé principale facultative : on peut la laisser vide une fois les clés individuelles créées.

## Mettre à jour

Installé avec `install.sh` : automatique chaque nuit vers 4 h 30 depuis la branche `main`. Pour le faire tout de suite :

```bash
sudo bash /opt/manif-friend/deploy/mise-a-jour.sh
```

Installation manuelle : `git pull && docker compose up -d --build`.

## Sauvegardes

Le service `sauvegarde` copie chaque jour la base (groupes, pseudos, manifs) et les clés organisateur·ices dans `./sauvegardes/` (fichiers lisibles par root uniquement, 14 jours gardés, `SAUVEGARDE_JOURS` pour changer). Positions et signalements ne sont jamais écrits sur disque.

Ces fichiers sont sensibles (qui est dans quel groupe) : ne pas les copier ailleurs sans les chiffrer.

Restaurer une sauvegarde :

```bash
docker compose stop app
docker compose cp sauvegardes/db-2026-10-20.json app:/data/db.json
docker compose start app
```

## Surveillance

- **Santé** : Docker redémarre l'appli si `/healthz` ne répond plus (healthcheck toutes les 30 s).
- **Alerte si le site tombe** : dans GitHub, *Settings → Secrets and variables → Actions → Variables*, créer `SITE_URL` = `https://manif-friend.fr`. Le workflow « Surveillance du site » vérifie alors toutes les heures et GitHub envoie un e-mail en cas d'échec. Pour être prévenu en 5 minutes : un compte gratuit [UptimeRobot](https://uptimerobot.com) (ou Uptime Kuma auto-hébergé ailleurs) sur `https://manif-friend.fr/healthz`.
- **Journaux** : seulement le démarrage, les erreurs et les compteurs d'import (jamais d'IP, de position ni de pseudo), limités à 3 Mo : `docker compose logs app`.

## Capacité

Mesures du test de charge (téléphones en groupes de 5, position toutes les 5 s, signalements) :

| Téléphones connectés | Processeur (1 cœur) | Mémoire | Signalement confirmé (95 %) |
|---|---|---|---|
| 5 000 | 14 % | 270 Mo | 19 ms |
| 10 000 | 27 % | 750 Mo | 150 ms |

Un VPS à 2 vCPU et 4 Go de RAM tient donc confortablement 10 000 personnes connectées en même temps. Relancer la mesure : onglet *Actions* de GitHub → « Test de charge » → *Run workflow* (nombre de téléphones au choix), ou `node scripts/load-test.js --clients 5000`.

## Avant une grosse manif

- **Carte** : la carte de France est servie par votre serveur, aucun fournisseur externe. Pour la mettre à jour (données OpenStreetMap récentes) : `MAP_MAX_AGE_DAYS=0 docker compose run --rm carte`. Disque limité : `MAP_MAXZOOM=12` dans `.env` (≈ 1,1 Go).
- **Validation des manifs** : donner la clé `ADMIN_KEY` à quelques personnes de confiance ; elles valident les manifs importées dans Infos → Espace organisateur·ices.
- **Capacité** : un processus Node tient plusieurs milliers de connexions simultanées sur un VPS à 2 vCPU. Au-delà, ajouter l'adaptateur Redis de Socket.IO et plusieurs instances.
- **Parcours officiel** : dans l'espace organisateur·ices, ✏️ sur la manif puis toucher la carte du départ à l'arrivée. Il disparaît automatiquement le lendemain.
