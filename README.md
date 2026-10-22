# Manif Friend

Carte collaborative en temps réel pour manifester en sécurité, partout en France métropolitaine et en Corse. Site web + application installable (PWA).

- **Se géolocaliser** au choix : pas de partage, **anonyme** ou **avec son pseudo**.
- **Groupes** : chacun·e peut créer un groupe et devient admin. Pour entrer, il faut scanner le QR code (ou ouvrir le lien, ou taper le code) **et** être accepté·e par un·e admin. Les membres acceptés voient où sont les autres membres.
- **Point de rendez-vous** par groupe : un·e admin le place sur la carte (lieu + heure), les membres sont prévenus et ont un itinéraire à pied pour s'y rendre si on se perd.
- **Manifs à venir** partout en France (onglet 📅 Manifs) : date, heure, lieu de départ ✊ et parcours quand il est connu. Elles sont **récupérées automatiquement toutes les 2 heures** dans les agendas militants (18 Démosphère locaux, Mobilizon, Paris-luttes.info), puis **validées par un·e organisateur·ice** avant d'apparaître. Les organisateur·ices peuvent aussi en ajouter à la main et tracer le parcours déclaré. Tout disparaît le lendemain.
- **Rassemblements non déclarés** : jamais importés ni publiés. Un·e admin de groupe peut fixer un rendez-vous daté visible **uniquement par les membres du groupe**.
- **Signalements** en direct sur la carte : cortège (avec sa direction), rue bloquée, nasse, gaz lacrymogène, violences policières, street medics, zone calme / sortie sûre, autre info.
- **Alertes** : le téléphone vibre si du gaz, des violences ou une nasse sont signalés à moins de 400 m.
- **Carte de foule** publique et agrégée : montre où est la manif sans montrer personne individuellement.
- **Anti-intox** : 👍 confirme un signalement (et prolonge sa durée), 3 👎 majoritaires le suppriment.

## Démarrer

```bash
npm install
npm start            # http://localhost:3000
```

Variables d'environnement : `PORT` (3000), `DATA_DIR` (`./data`), `SERVER_SECRET` (aléatoire à chaque démarrage si absent), `ADMIN_KEY` (clé de l'espace organisateur·ices ; sans elle, le tracé de parcours est désactivé).

Avec Docker :

```bash
docker build -t manif-friend .
docker run -p 3000:3000 -v manif-data:/data manif-friend
```

## Mise en ligne

**Version de test gratuite, en 5 minutes :**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/KantMad/manifriend)

Voir [DEPLOY.md, « Version de test gratuite »](DEPLOY.md#version-de-test-gratuite-render) pour les étapes et les limites.

**Version définitive :** le guide pas à pas est dans **[DEPLOY.md](DEPLOY.md)** (Docker Compose + Caddy, HTTPS automatique).

La géolocalisation et l'installation en PWA **exigent HTTPS**. Mettre le serveur derrière un reverse proxy (Caddy, Nginx…) avec un certificat, en gardant le support des WebSockets. Exemple Caddy :

```
manif-friend.example.org {
  reverse_proxy localhost:3000
}
```

L'application tourne en un seul processus (l'état temps réel est en mémoire). Pour plusieurs instances, il faudrait ajouter l'adaptateur Redis de Socket.IO.

## Vie privée — ce que le serveur garde

| Donnée | Où | Durée |
|---|---|---|
| Position | mémoire uniquement | 5 min après la dernière mise à jour |
| Signalements et votes | mémoire uniquement | 20 à 60 min selon le type, prolongé par les 👍 |
| Pseudo, groupes, membres, demandes, rendez-vous | `data/db.json` | supprimés après 30 jours sans activité (`INACTIVE_DAYS`) |
| Adresse IP | mémoire uniquement, pour limiter les abus | 1 h maximum |
| Manifs (titre, date, lieu, parcours, lien source) | `data/db.json` | jusqu'au lendemain de la manif |

- Pas de compte, ni e-mail, ni téléphone : l'identité est un jeton aléatoire stocké sur l'appareil (le serveur n'en garde qu'une empreinte).
- En mode anonyme, les autres membres voient « membre anonyme » avec un identifiant propre au groupe, qu'on ne peut pas relier entre deux groupes.
- La carte de foule publique ne montre que des zones d'environ 200 m contenant **au moins 3 personnes**.
- Un simple visiteur (qui regarde la carte ou signale) ne laisse **aucune trace** dans la base : une fiche n'existe qu'après le choix d'un pseudo, pour rejoindre ou créer un groupe.
- Les dates d'activité sont gardées au jour près, jamais à l'heure.
- **Effacement d'urgence** : toucher 3 fois le logo efface tout sans confirmation (utile en cas d'arrestation ou de vol du téléphone).
- Le bouton « Effacer toutes mes données » supprime le pseudo, retire l'utilisateur de tous ses groupes et oublie l'appareil.

## Limites à connaître

- **Le serveur voit les positions en temps réel.** La personne qui l'héberge (ou une autorité qui le saisirait) pourrait les voir pendant une manif. Héberger chez un hébergeur de confiance, ne pas activer de logs d'accès dans le reverse proxy, et le dire clairement aux utilisateurs.
- **Carte** : la carte de Paris (données OpenStreetMap, format PMTiles) est servie par notre propre serveur, donc aucun service tiers ne voit qui consulte quelle zone. Elle est téléchargée à la construction de l'image Docker (`npm run map` en local). Sans ce fichier, l'appli se rabat sur les tuiles d'OpenStreetMap.
- **En arrière-plan** : un navigateur (surtout sur iPhone) arrête la géolocalisation quand l'écran est verrouillé. L'option « Garder l'écran allumé » aide pendant la manif.
- **Réseau saturé** : en grosse manif, le réseau mobile sature souvent. L'appli et les tuiles déjà vues restent disponibles hors-ligne, et la connexion se rétablit toute seule.
- **Import automatique** : les agendas ne donnent presque jamais le tracé du parcours, seulement le lieu de départ. Le lieu peut être approximatif ; c'est pour cela que chaque manif est validée par un humain avant publication.
- **Modération** : les signalements sont anonymes ; le vote 👎 et la limite de 4 signalements / 2 min par appareil limitent les abus, sans les empêcher complètement.

## Carte de France

```bash
npm run map                                  # map/carte.pmtiles : France entière, zoom 14 (≈ 4,4 Go)
MAP_MAXZOOM=12 npm run map                   # plus léger (≈ 1,1 Go), moins de détails en zoomant
MAP_BBOX=2.10,48.70,2.60,49.00 npm run map   # Paris seul (≈ 100 Mo), pratique pour développer
```

Carte claire par défaut (lisible en plein soleil), carte sombre au choix dans l'onglet Carte. Les zones déjà vues restent disponibles hors-ligne.

## Import des manifs

- Sources configurées dans `config/sources.json` : 18 Démosphère locaux (flux iCal), Mobilizon (API GraphQL, mobilizon.fr), Paris-luttes.info (page agenda). Démosphère Paris/IDF est fermé ; Paris est couvert par les deux autres.
- Filtre : ne garde que les manifestations, rassemblements, marches, grèves, blocages… et écarte réunions, projections, concerts, formations, ainsi que tout ce qui est dit « sauvage » ou « non déclaré ».
- Lieu : coordonnées de la source si elles existent, sinon géocodage par la Base Adresse Nationale (IGN), vérifié par ville. Un lieu seulement approximatif est signalé comme tel.
- Toutes les manifs importées arrivent **« à valider »** dans l'espace organisateur·ices (Infos → Espace organisateur·ices, clé `ADMIN_KEY`) : publier, refuser, corriger le lieu, tracer le parcours.
- Rythme : `IMPORT_EVERY_MIN` (120 par défaut, 0 pour désactiver). Essai à blanc : `node scripts/import-events.js --dry-run`.

## Tests

```bash
npm test              # unitaires + intégration + sécurité (rapide, sans navigateur)
npm run test:e2e      # tests dans Chromium (Playwright) : XSS, mise en page, parcours complet
npm run coverage      # couverture du code serveur
npm run test:security # tests de sécurité + audit des dépendances
```

| Dossier | Ce qui est vérifié |
|---|---|
| `test/unit` | Fonctions pures du serveur et du client ; lecteur iCal, filtre « manif », géocodage, chaque importeur sur des données simulées |
| `test/integration` | Serveur réel + clients temps réel : groupes, adhésion, rendez-vous datés, signalements, votes, positions, manifs (import, validation, publication, expiration), persistance |
| `test/security` | Authentification, droits d'admin, cloisonnement des groupes, fuite de positions, anonymat, pollution de prototype, fuzzing, limites anti-abus, en-têtes HTTP et CSP, traversée de répertoires |
| `test/e2e` | Navigateur : visite guidée (chaque étape vérifiée de 320 à 1440 px), premier lancement sans compte, XSS, parcours à deux téléphones avec QR code, effacement d'urgence, mise en page de 320 px à 1440 px |

La CI GitHub lance tout à chaque envoi, plus :
- **Test de déploiement** : `docker compose up` complet (appli, carte, sauvegarde, Caddy en HTTPS) puis `scripts/smoke-test.js`, données conservées après redémarrage, sauvegarde, journaux sans donnée personnelle ;
- **Test de charge** : 5 000 téléphones simulés (`scripts/load-test.js`) ;
- **Captures** avec la vraie carte, publiées sur la branche `captures`.

## Structure

```
server.js              Express + Socket.IO : groupes, positions, signalements, carte de foule
lib/util.js            Fonctions pures (validation, limites, anonymat…)
public/utils.js        Fonctions pures du client
scripts/download-map.sh  Téléchargement de la carte de Paris
scripts/screenshots.js Captures d'écran avec la vraie carte
test/                  Tests unitaires, d'intégration, de sécurité et navigateur
public/index.html      Interface (carte plein écran + panneaux)
public/app.js          Logique client (Leaflet, géolocalisation, groupes, signalements)
public/style.css       Thème sombre, pensé pour mobile
public/sw.js           Service worker (hors-ligne + cache des tuiles)
public/manifest.webmanifest, public/icons/   PWA
scripts/icons.js       Génère les icônes PNG à partir de icon.svg (Playwright)
```
