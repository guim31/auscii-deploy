# Runbook (exploitation)

Ce document décrit l'installation, l'exploitation et la reprise du pilote, puis le branchement de chaque service externe et les incidents connus.

## Prérequis côté agence

| Service                           | À préparer                                                                                                                                                                                                                             | Utilisé pour                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Scaleway                          | Projet, clé API (Instances), zone par défaut ; un seau Object Storage et une clé IAM dédiée aux sauvegardes                                                                                                                            | Commande des VPS sites, sauvegardes du pilote                 |
| Gandi                             | Compte avec moyen de paiement, clé API (PAT) avec droits domaine et LiveDNS, organisation propriétaire par défaut                                                                                                                      | Achat de domaines, DNS                                        |
| Domaine technique                 | Un domaine dédié acheté chez Gandi (ex. `auscii.site`). `auscii.com` reste chez OVH avec les emails et n'est jamais modifié                                                                                                            | Outil (`deploy.…`), domaine d'envoi des emails                |
| Domaine des aperçus               | Un **second** domaine, distinct du domaine technique (ex. `auscii-preview.site`), chez Gandi avec LiveDNS                                                                                                                              | Aperçus de l'étape 3 (`apercu.…`) et préproductions des sites |
| GitHub                            | Une organisation AUSCII, une GitHub App installée dessus (permissions : contents et administration des dépôts), une clé de déploiement en lecture sur `auscii-deploy`, un PAT classique `read:packages`. Aucun compte pour les gérants | Un repo par site, images et fichiers du pilote                |
| Resend                            | Compte et clé API (accès complet). Le domaine d'envoi est le domaine technique, déclaré et vérifié depuis l'outil                                                                                                                      | Formulaires, alertes                                          |
| Anthropic                         | Clé API (console.anthropic.com). Modèle `claude-opus-5` par défaut, modifiable dans Paramètres > Intégrations                                                                                                                          | Rapport de relecture à l'étape 3                              |
| Coffre de mots de passe           | Une entrée « Pilote auscii-deploy » : `.env` complet, clé privée age des sauvegardes, PAT GHCR, clé de déploiement                                                                                                                     | Reprise après sinistre                                        |
| Surveillance externe (facultatif) | Un compte healthchecks.io (ou équivalent) et une sonde HTTP (UptimeRobot, Better Stack…)                                                                                                                                               | Alerte si la sauvegarde ou l'outil tombe                      |

## Pilote (hébergement de l'outil)

- Un VPS Scaleway dédié, Debian 12, 2 vCPU / 4 Go et 40 Go de disque recommandés (les archives des sites s'accumulent, voir « Sauvegardes »).
- Pile Docker Compose dans `infra/pilot/`, installée dans `/opt/auscii-deploy` :
  - `db` : PostgreSQL 16 (image figée `postgres:16.15-alpine`) ;
  - `migrate` : applique les migrations Prisma et s'arrête ;
  - `app` : Next.js autonome, avec une sonde de santé sur `/api/health` ;
  - `worker` : jobs pg-boss, avec `git` et Chromium ;
  - `caddy` : HTTPS automatique (image figée `caddy:2.11.4-alpine`) ;
  - `backup` : sauvegarde nocturne, avec sa propre sonde de santé.
- Trois images publiées par la CI sur `ghcr.io/<org>/auscii-deploy-app`, `-worker` et `-backup`, étiquetées par le **SHA court du commit** (7 caractères, ex. `3f8a1c2`). Pas d'étiquette `latest` : le pilote tourne toujours sur un SHA précis, ce qui rend le retour arrière possible. Les images ne sont publiées qu'après les tests et un test de fumée de la pile complète (`infra/pilot/smoke-test.sh`).
- Tous les conteneurs tournent à l'heure de Paris (`TZ=Europe/Paris`) ; leurs journaux sont limités à 5 × 20 Mo par conteneur (pilote `local` de Docker).
- Les clés des intégrations ne sont pas dans `.env` : elles se saisissent dans l'interface et sont chiffrées en base avec `APP_ENCRYPTION_KEY`.
- Clé SSH du pilote générée depuis Paramètres > Intégrations, stockée chiffrée en base, clé publique affichée pour les scripts d'installation des serveurs de sites.

### Deux domaines : l'outil et les aperçus

Le pilote répond sur deux noms, qui doivent appartenir à **deux domaines enregistrables différents** :

| Nom                | Exemple                      | Rôle                                                                                                        |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PILOT_HOST`       | `deploy.auscii.site`         | L'outil : connexion, wizard, relais des formulaires (`/api/forms`)                                          |
| `PREVIEW_APP_HOST` | `apercu.auscii-preview.site` | Les aperçus des versions déposées (étape 3), affichés dans une iframe de l'outil. Seul `/apercu/*` y répond |

Pourquoi : un aperçu exécute le HTML et le JavaScript d'un zip client. Sur un sous-domaine du domaine de l'outil, ce code serait « same-site » avec lui : il pourrait poser des cookies sur tout le domaine et contourner la protection `SameSite` des sessions. Un domaine enregistrable distinct (acheter par exemple `auscii-preview.site`) supprime ce risque. `install.sh` refuse deux noms qui partagent le même domaine.

Les **préproductions des sites** (`<slug>.<domaine des préproductions>`, servies par les serveurs de sites) vivent sous ce même domaine séparé, pour la même raison : les réglages se font dans Paramètres > Agence, champ « domaine des préproductions ». Ce choix est à faire **avant le premier vrai site** : le changer ensuite casse les liens déjà envoyés aux clients.

Côté Caddy (`Caddyfile.pilot`) :

- sur `PILOT_HOST`, `/apercu/*` répond 404 ; `/api/forms` accepte 64 Ko au plus, le reste 60 Mo (dépôt des zips) ; la CSP de l'application est complétée avec l'origine des aperçus (`frame-src`) ;
- sur `PREVIEW_APP_HOST`, seul `/apercu/*` est relayé à l'application, sans `X-Frame-Options` : l'application y pose sa propre CSP (`frame-ancestors`) ;
- les serveurs de sites relaient les formulaires vers `https://<PILOT_HOST>/api/forms` avec un secret par site (`X-Auscii-Relay`) ; Caddy transmet ces en-têtes tels quels.

### Variables du `.env`

Fichier `/opt/auscii-deploy/.env`, `chmod 600`, root uniquement, écrit par `install.sh`. Syntaxe `NOM='valeur'` : entre apostrophes, Compose ne remplace pas les `$` (une apostrophe dans une valeur s'écrit `\'`). Modèle commenté : `infra/pilot/.env.example`.

| Variable               | Obligatoire | Rôle                                                                                                                               |
| ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PILOT_HOST`           | oui         | Nom de l'outil. `APP_URL` vaut `https://$PILOT_HOST` ; les serveurs de sites en déduisent l'adresse du relais des formulaires      |
| `PREVIEW_APP_HOST`     | oui         | Nom des aperçus, sur un autre domaine. L'application reçoit `PREVIEW_ORIGIN=https://$PREVIEW_APP_HOST`                             |
| `ACME_EMAIL`           | oui         | Contact Let's Encrypt                                                                                                              |
| `GHCR_OWNER`           | oui         | Organisation GitHub qui publie les images, en minuscules (ex. `auscii`)                                                            |
| `IMAGE_TAG`            | oui         | SHA court en service. Jamais `latest` : `install.sh` et `update.sh` le refusent                                                    |
| `PREVIOUS_IMAGE_TAG`   | non         | SHA précédent, écrit par `update.sh` ; ses images sont gardées par `prune-images.sh`                                               |
| `POSTGRES_PASSWORD`    | oui         | Mot de passe de la base (tiré au hasard)                                                                                           |
| `BETTER_AUTH_SECRET`   | oui         | Secret des sessions. Le changer déconnecte tout le monde                                                                           |
| `APP_ENCRYPTION_KEY`   | oui         | Clé de chiffrement des secrets en base (intégrations, clé SSH du pilote). **Irremplaçable** : sa perte rend ces secrets illisibles |
| `DEMO_MODE`            | non         | `false` sur le pilote. `true` force les mocks                                                                                      |
| `BACKUP_HOUR`          | non         | Heure de la sauvegarde nocturne, **heure de Paris** (0-23, 3 par défaut)                                                           |
| `BACKUP_PING_URL`      | non         | URL de surveillance pingée après chaque sauvegarde (`<url>` si réussie, `<url>/fail` sinon)                                        |
| `BACKUP_AGE_RECIPIENT` | pour S3     | Clé publique age (`age1…`) qui chiffre les envois vers Object Storage ; la clé privée est dans le coffre, jamais sur le serveur    |
| `S3_BUCKET`            | non         | Seau Object Storage ; vide = sauvegardes locales seulement                                                                         |
| `S3_ENDPOINT`          | non         | `https://s3.fr-par.scw.cloud` par défaut                                                                                           |
| `S3_REGION`            | non         | `fr-par` par défaut                                                                                                                |
| `S3_ACCESS_KEY`        | pour S3     | Clé d'accès IAM (`SCW…`)                                                                                                           |
| `S3_SECRET_KEY`        | pour S3     | Clé secrète IAM                                                                                                                    |

Le compte administrateur n'est pas dans `.env` : `install.sh` le demande et le crée une fois (`prisma/seed.ts`, 12 caractères minimum). Un admin supprimé n'est jamais recréé par un redémarrage.

### Accès aux images et au dépôt

- **Images** : publiées sous l'organisation (`ghcr.io/auscii/…`, `GHCR_OWNER=auscii`) par le workflow CI du dépôt de l'organisation. Si les paquets sont privés, créer un **PAT classique** (les jetons « fine-grained » ne donnent pas accès à GHCR) avec la seule portée `read:packages`, sur un compte membre de l'organisation, avec une date d'expiration notée dans le coffre. Sur le pilote : `export GHCR_USER=<compte> GHCR_TOKEN=<pat>` avant `install.sh` (qui fait le `docker login`), ou `docker login ghcr.io` à la main. L'identifiant est gardé par Docker dans `/root/.docker/config.json`. À l'expiration : nouveau PAT, `docker login ghcr.io`, rien d'autre.
- **Dépôt** : le pilote garde un clone de `auscii-deploy` dans `/opt/auscii-deploy/src` ; `update.sh` y prend les fichiers de la pile au commit du tag installé. Dépôt privé : créer une **clé de déploiement en lecture seule** (GitHub > dépôt > Settings > Deploy keys) :

  ```bash
  ssh-keygen -t ed25519 -N '' -C auscii-pilot -f /root/.ssh/auscii_deploy_repo
  cat /root/.ssh/auscii_deploy_repo.pub          # à coller dans Deploy keys, sans droit d'écriture
  cat >>/root/.ssh/config <<'EOF'
  Host github.com
    IdentityFile /root/.ssh/auscii_deploy_repo
    IdentitiesOnly yes
  EOF
  ```

### Installation à blanc

Prérequis : un VPS Debian 12 neuf avec votre clé SSH root, deux enregistrements `A` vers son IP publique (`PILOT_HOST` et `PREVIEW_APP_HOST` ; les certificats ne peuvent pas être émis sans), la clé de déploiement ci-dessus, et le SHA à installer (dernier job « images » réussi de la CI sur `main`).

```bash
apt-get update && apt-get install -y git
git clone git@github.com:auscii/auscii-deploy.git /opt/auscii-deploy/src
export GHCR_USER=<compte> GHCR_TOKEN=<pat read:packages>    # si les images sont privées
bash /opt/auscii-deploy/src/infra/pilot/install.sh
```

Le script :

1. installe Docker, limite ses journaux (`/etc/docker/daemon.json`), copie la pile dans `/opt/auscii-deploy` ;
2. demande les deux noms d'hôte, l'email Let's Encrypt, l'organisation des images et le SHA (par défaut, celui du clone), et éventuellement le seau S3 ; tire les secrets au hasard ;
3. durcit le système : pare-feu limité à 22, 80 et 443, SSH par clé uniquement (`/etc/ssh/sshd_config.d/00-auscii.conf`, vérifié par `sshd -t`, et seulement si une clé autorisée existe), `fail2ban` sur le journal systemd, mises à jour automatiques ;
4. récupère les images, applique les migrations, démarre la pile et attend la santé de l'application et du worker ;
5. demande le premier compte administrateur (12 caractères minimum) et le crée ;
6. génère la paire de clés age des sauvegardes (la clé publique va dans `.env`, la clé privée est affichée une seule fois) et fait une première sauvegarde ;
7. **demande de confirmer** que le `.env` complet et la clé privée age sont enregistrés dans le coffre de l'agence.

Ensuite, dans l'interface : Paramètres > Agence (domaine technique, domaine des préproductions, contact propriétaire, email des alertes), Paramètres > Intégrations (clés des cinq services, puis « Tester »), et génération de la paire de clés SSH du pilote.

### Mise à jour

```bash
cd /opt/auscii-deploy
./update.sh 3f8a1c2      # SHA court affiché par la CI (résumé du job « images »)
```

Le script :

1. refuse `latest` et le tag déjà en service ;
2. copie les fichiers de la pile et le `.env` dans `.rollback/<date>/` (5 dernières copies gardées) ;
3. met à jour `src/` (`git fetch`, puis le commit du tag) et en recopie `docker-compose.yml`, `Caddyfile.pilot`, `.env.example` et les scripts : **la pile et les images viennent toujours du même commit**. Une nouvelle version de `update.sh` sert à partir de la mise à jour suivante. Si la nouvelle pile demande une variable absente du `.env`, il s'arrête sans rien changer (comparer avec `.env.example`). `--skip-files` garde les fichiers actuels (dépôt injoignable) ;
4. sauvegarde la base et les fichiers dans `pre-update/` (5 dernières gardées, pas d'envoi S3) ; si elle échoue, rien n'est changé ;
5. récupère les images du nouveau tag ;
6. applique les migrations et redémarre (`app` et `worker` sont arrêtés pendant les migrations) ;
7. attend la santé de l'application et vérifie que le worker tient.

En cas d'échec aux étapes 6 ou 7, il revient seul aux fichiers, au `.env` et au tag précédents, puis **propose de restaurer la base** sauvegardée à l'étape 4 : des migrations ont pu être appliquées, et l'ancienne version n'est pas garantie sur un schéma plus récent. Répondre oui est recommandé ; seules les écritures faites pendant la mise à jour (quelques minutes, application arrêtée) sont perdues. `--yes` répond oui d'avance ; sans terminal, la réponse est non. Les messages indiquent quel journal lire : `docker compose logs migrate` pour une migration, `docker compose logs app` ou `worker` sinon.

Les déploiements de sites en cours au moment de la mise à jour sont repris par le worker au redémarrage : les pipelines reprennent à l'étape où ils s'étaient arrêtés.

**Revenir volontairement à une version précédente** : `./update.sh <PREVIOUS_IMAGE_TAG>` suffit si aucune migration n'a eu lieu entre les deux. Sinon, restaurer d'abord la sauvegarde `pre-update` de la mise à jour (`./restore.sh db-<date>.sql.gz`), puis `./update.sh <ancien tag>`.

**Place disque** : `update.sh` ne supprime que les images sans étiquette. `./prune-images.sh` supprime les images des anciens tags en gardant `IMAGE_TAG` et `PREVIOUS_IMAGE_TAG`. Ne pas utiliser `docker system prune -a` : il supprime aussi l'image du tag précédent, nécessaire au retour arrière.

### Sauvegardes

Le service `backup` (image `auscii-deploy-backup`, script `infra/pilot/backup.sh`) sauvegarde chaque nuit à `BACKUP_HOUR`, heure de Paris :

- `db-<date>.sql.gz` : dump complet de PostgreSQL (application et file pg-boss). Il contient les sessions et les messages des formulaires : ce sont des **données personnelles** ;
- `data-<date>.tar.gz` : les fichiers de `/data`, **sans** `git/` (copies de travail, reconstruites depuis GitHub) ni `uploads/` (envois en cours). Les `releases/` sont gardées : le retour arrière et la republication en ont besoin sur le pilote. Elles pèsent jusqu'à 50 Mo par version déposée et ne sont pas encore purgées : surveiller la taille des archives (`docker compose exec backup du -sh /backups`).

Chaque fichier est écrit en `.tmp`, vérifié (`gzip -t`, taille minimale, marqueur de fin de `pg_dump`) puis renommé. La rotation (7 quotidiennes, 4 hebdomadaires, copie du dimanche) n'a lieu qu'après une sauvegarde complète : un dump raté ne chasse jamais les bons.

Si `S3_BUCKET` est renseigné, les deux fichiers sont **chiffrés avec age** pour `BACKUP_AGE_RECIPIENT`, puis envoyés dans `s3://<seau>/<année>/<mois>/<fichier>.age`. Sans clé age, l'envoi est refusé : rien ne part en clair.

Codes de sortie de `backup.sh run` : `0` quand la sauvegarde locale est bonne, **même si l'envoi S3 échoue** (avertissement dans le journal, état `upload_failed`, ping d'échec) ; `1` quand le dump ou l'archive échoue. `update.sh` ne s'arrête donc que si la sauvegarde locale est impossible.

État et journaux :

```bash
cd /opt/auscii-deploy
docker compose ps backup                                   # (healthy) ou (unhealthy)
docker compose exec backup cat /backups/status             # dernier résultat, dernière réussite
docker compose exec backup tail -n 50 /backups/backup.log  # journal persistant (1 Mo, puis backup.log.1)
docker compose logs backup                                 # sortie des tâches planifiées
docker compose run --rm backup run                         # sauvegarde à la demande
```

### Object Storage (Scaleway)

1. Console Scaleway > Object Storage > Créer un seau : région `fr-par`, nom ex. `auscii-pilot-backups`, visibilité **privée**.
2. Onglet « Cycle de vie » du seau : règle « expiration » à 90 jours sur tout le seau (préfixe vide). Sans elle, les sauvegardes s'accumulent et se facturent indéfiniment.
3. IAM > Applications : créer « auscii-pilot-backups », politique `ObjectStorageFullAccess` sur le projet du seau (pour que la clé n'atteigne que ce seau : dédier un projet aux sauvegardes, ou poser une _bucket policy_), puis générer une clé API. Reporter la clé d'accès et la clé secrète dans `S3_ACCESS_KEY` et `S3_SECRET_KEY`.
4. Vérifier `BACKUP_AGE_RECIPIENT` (écrit par `install.sh`) ; sinon générer une paire : `docker compose run --rm --no-deps --entrypoint age-keygen backup`, mettre la ligne `# public key: age1…` dans `.env` et la ligne `AGE-SECRET-KEY-1…` dans le coffre.
5. `docker compose up -d backup`, puis `docker compose run --rm backup run` : le journal doit finir par « envoi terminé », et les fichiers `.age` apparaître dans la console.

Le chiffrement côté serveur de Scaleway (SSE-C) n'est pas utilisé : il protège le disque de Scaleway, pas une fuite de la clé IAM. Avec age, une clé IAM volée ne donne que des fichiers illisibles, et le pilote lui-même ne peut pas relire ses envois.

### Restauration

`./restore.sh` arrête `app`, `worker` et `backup`, remplace la base dans **une seule transaction** (schémas `public` et `pgboss` supprimés puis recréés depuis le dump ; en cas d'erreur, rien n'est modifié), remplace les dossiers de `/data` présents dans l'archive (`releases/`, `screenshots/`…), puis redémarre et attend la santé. Les copies de travail `git/` sont laissées : elles se resynchronisent avec GitHub au prochain envoi.

```bash
cd /opt/auscii-deploy
./restore.sh                                                    # liste les sauvegardes locales
./restore.sh db-20260903-030000.sql.gz data-20260903-030000.tar.gz
./restore.sh db-20260903-030000.sql.gz                          # base seule
```

Depuis Object Storage (demande la clé privée age du coffre ; rien n'est installé sur l'hôte, `aws` et `age` sont dans l'image de sauvegarde) :

```bash
./restore.sh --from-s3 2026/09/db-20260903-030000.sql.gz.age 2026/09/data-20260903-030000.tar.gz.age
```

Les fichiers sont rapatriés et déchiffrés dans le volume des sauvegardes (`restore/`), puis restaurés comme ci-dessus. Pour lister le seau : `docker compose --profile tools run --rm restore -c 'aws --endpoint-url "$S3_ENDPOINT" s3 ls --recursive "s3://$S3_BUCKET/"'`.

### Reconstruire le pilote sur un nouveau VPS

À faire si le VPS est perdu, ou pour tester la procédure (au moins une fois par an, et avant de considérer la phase 8 terminée).

Il faut, depuis le coffre : le `.env` complet, la clé privée age, le PAT GHCR, et la clé de déploiement du dépôt (ou en créer une nouvelle).

1. Nouveau VPS Debian 12 avec votre clé SSH ; basculer les enregistrements `A` de `PILOT_HOST` et `PREVIEW_APP_HOST` vers sa nouvelle IP.
2. Déposer le `.env` du coffre dans `/root/auscii.env` (`chmod 600`), installer la clé de déploiement, cloner le dépôt dans `/opt/auscii-deploy/src` et se placer sur le commit de `IMAGE_TAG` (`git -C /opt/auscii-deploy/src checkout <IMAGE_TAG>`).
3. `bash /opt/auscii-deploy/src/infra/pilot/install.sh --env /root/auscii.env` : il reprend ce `.env` sans rien demander ni générer, et démarre une pile vide (aucun compte n'est créé).
4. `cd /opt/auscii-deploy && ./restore.sh --from-s3 <année>/<mois>/db-….sql.gz.age <année>/<mois>/data-….tar.gz.age` avec la dernière sauvegarde du seau.
5. Vérifier : connexion avec un compte existant, Paramètres > Intégrations > « Tester » sur chaque service (preuve que `APP_ENCRYPTION_KEY` est la bonne), « Retester » sur un serveur de sites (la clé SSH du pilote déchiffrée fonctionne), un envoi de formulaire depuis un site.
6. Supprimer `/root/auscii.env`, et l'ancien VPS s'il existe encore.

Pour un **test** sans toucher la production : même procédure sur un VPS temporaire avec deux noms de test (ex. `deploy-test.auscii.site`, `apercu-test.auscii-preview.site`) écrits dans une copie du `.env`, `DEMO_MODE='true'` pour qu'aucun job ne touche les vrais serveurs, et sans basculer le DNS de production. Supprimer le VPS ensuite.

### Surveillance du pilote

- **Outil** : une sonde HTTP externe sur `https://<PILOT_HOST>/api/health` (200 attendu, 503 si la base est injoignable ou la configuration refusée), toutes les 5 minutes, alerte par email.
- **Sauvegardes** : renseigner `BACKUP_PING_URL` avec un contrôle healthchecks.io (période 1 jour, tolérance 2 h) : une alerte part si le ping n'arrive pas ou si `<url>/fail` est appelé (dump en échec, envoi S3 en échec). Sans service externe, le service `backup` passe « unhealthy » (`docker compose ps`) si la dernière sauvegarde a échoué ou date de plus de 26 h ; il faut alors le regarder régulièrement.
- **Disque** : `df -h /` et `docker system df` une fois par mois ; au-delà de 80 %, voir l'incident « disque plein ».
- **Certificats** : Caddy les renouvelle seul ; la sonde HTTP échoue s'ils expirent.

### Rotation d'une clé

- **Clé d'une intégration** (Gandi, Scaleway, GitHub, Resend, Anthropic) : Paramètres > Intégrations, coller la nouvelle valeur, « Enregistrer », puis « Tester ». L'ancienne est écrasée en base ; révoquer ensuite chez le fournisseur.
- **Clé SSH du pilote** : générer une nouvelle paire dans Paramètres > Intégrations, ajouter la nouvelle clé publique dans `/home/deploy/.ssh/authorized_keys` de chaque serveur de sites **avant** de retirer l'ancienne, vérifier avec « Retester » sur chaque serveur.
- **`APP_ENCRYPTION_KEY`** : ne peut pas être changée sans réécrire les secrets chiffrés. Procédure : noter les clés des intégrations, vider la table `Integration`, changer la variable dans `.env`, redémarrer, ressaisir les clés, puis mettre à jour le coffre.
- **`BETTER_AUTH_SECRET`** : la changer déconnecte tout le monde, sans autre conséquence. Mettre à jour le coffre.
- **Clé age des sauvegardes** : nouvelle paire (voir « Object Storage »), nouvelle clé publique dans `.env`, `docker compose up -d backup`. Garder l'ancienne clé privée dans le coffre tant que des sauvegardes chiffrées avec elle existent dans le seau (90 jours).
- **PAT GHCR** : nouveau PAT `read:packages`, `docker login ghcr.io`, révoquer l'ancien.

### Checklist de validation de la phase 8

1. CI verte sur `main`, y compris le job « images » (construction des trois images et test de fumée de la pile) ; le résumé du job donne le SHA publié.
2. Installation à blanc sur un VPS neuf en suivant ce document mot pour mot : `install.sh` se termine sans erreur, les deux certificats sont émis, la connexion fonctionne avec le compte saisi.
3. `https://<PREVIEW_APP_HOST>/` répond 404 ; `https://<PILOT_HOST>/apercu/x` répond 404.
4. `.env` et clé privée age enregistrés dans le coffre, vérifiés par une deuxième personne.
5. Sauvegarde nocturne présente le lendemain (`/backups/status`), fichiers `.age` dans le seau, ping reçu par la surveillance ; un envoi volontairement cassé (mauvaise clé S3) déclenche l'alerte d'échec.
6. Mise à jour vers un autre SHA avec `update.sh` réussie ; puis une mise à jour vers un tag inexistant refusée sans rien changer.
7. Restauration de test : `./restore.sh` d'une sauvegarde locale, puis `--from-s3` sur un VPS de test (« Reconstruire le pilote »), avec les vérifications de l'étape 5 de cette procédure.
8. `docker compose ps` : tous les services `healthy` ou `running`, `docker compose logs` sans erreur ; redémarrage du VPS (`reboot`) puis retour automatique de la pile.

## Développement local

```bash
cp .env.example .env           # puis adapter APP_ENCRYPTION_KEY et BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d db        # PostgreSQL 16
pnpm install
pnpm db:migrate                # migrations Prisma
pnpm db:seed                   # premier compte admin (ADMIN_EMAIL / ADMIN_PASSWORD de .env, 12 caractères minimum)
pnpm dev                       # app sur http://localhost:3000 + worker
```

Avec `DEMO_MODE=true`, tout le parcours fonctionne sans aucune clé API ni réseau sortant. `PREVIEW_ORIGIN` vide : l'outil sert lui-même les aperçus.

Tests :

- `pnpm test` : Vitest, sur la base `DATABASE_URL_TEST` (créée et migrée au premier lancement). Les tests effacent les données de démo : ils refusent de tourner si `DATABASE_URL_TEST` manque alors que `DATABASE_URL` est définie, ou si les deux désignent la même base.
- `pnpm e2e` : Playwright en mode démo sur `next dev` (démarre l'app et le worker) ; `pnpm build && pnpm e2e:build` : sur le build de production (`next start`), comme la CI.
- Test de fumée des images, sur une machine avec Docker : construire les trois cibles du `Dockerfile` sous `ghcr.io/<org>/auscii-deploy-{app,worker,backup}:<tag>`, puis `GHCR_OWNER=<org> IMAGE_TAG=<tag> bash infra/pilot/smoke-test.sh`.

## Ajouter un serveur existant (phase 2)

1. Paramètres > Intégrations > SSH : **Générer une paire de clés** (ou importer une clé privée OpenSSH existante). La clé publique s'affiche.
2. Créer un VPS Debian 12 (Scaleway DEV1-S conseillé) avec un accès root.
3. Paramètres > Serveurs > **Ajouter un serveur existant** : copier le script affiché (il contient la clé publique), le lancer en root sur le VPS (`bash bootstrap.sh`). Il installe Caddy, Docker, le pare-feu, l'utilisateur `deploy` et pose le marqueur `/var/lib/auscii-ready`.
4. Renseigner le nom, l'IP et valider. L'outil attend le marqueur, mémorise l'empreinte de la clé d'hôte (vérifiée à chaque connexion) et relève les métriques. Le serveur passe à « Prêt ».
5. En cas d'erreur : « Retester ». Après une réinstallation du serveur : « Oublier la clé d'hôte » puis retester.

## DNS manuel (sans Gandi)

Tant que l'intégration Gandi n'est pas configurée, le wizard force « domaine déjà possédé » et le provisioning ignore l'achat et le DNS. La page du site affiche les trois enregistrements `A` à créer chez le registrar : l'apex et `www` du domaine client, et le nom de préproduction du site (sous le domaine des préproductions). Caddy émet le certificat HTTPS dès que le nom résout vers le serveur. Le relais des formulaires (`/__forms/*`) passe par le pilote (`https://<PILOT_HOST>/api/forms`), qui doit être joignable publiquement.

## Gandi (phase 3)

1. Sur gandi.net : Paramètres du compte > Sécurité > Jetons d'accès personnels. Créer un jeton lié à l'organisation qui portera les domaines, avec les droits ci-dessus. Le copier dans Paramètres > Intégrations > Gandi, puis « Tester » : l'outil affiche le compte et l'organisation.
2. Paramètres > Agence : renseigner l'identifiant d'organisation (affiché par le test) et le contact propriétaire complet (raison sociale, prénom, nom, email, téléphone au format `+33.612345678`, adresse, code postal, ville, pays). Gandi refuse tout achat avec un contact incomplet ; l'outil le vérifie à blanc (`Dry-Run`) avant de facturer.
3. Chaque achat active le renouvellement automatique. Un job quotidien rafraîchit la date d'expiration ; le tableau de bord signale un domaine à moins de 30 jours sans renouvellement automatique.
4. Le domaine technique (`auscii.site` ou autre) et le domaine des préproductions (`auscii-preview.site` ou autre) doivent être chez Gandi avec LiveDNS pour que les enregistrements soient créés automatiquement.

## Scaleway (phase 4)

1. Console Scaleway > IAM > Applications : créer l'application « auscii-deploy », lui attribuer une politique avec `InstancesFullAccess` sur le projet (ajoutez `ProjectReadOnly` pour que le test identifie le projet), puis générer une clé API. Copier la clé secrète et l'identifiant du projet dans Paramètres > Intégrations > Scaleway, puis « Tester ».
2. Paramètres > Agence : offre par défaut (`DEV1-S` conseillé) et zone (`fr-par-1`). Les prix affichés sont estimés à partir du tarif horaire (× 730 h).
3. La clé SSH du pilote doit exister avant toute commande : elle est injectée dans le cloud-init du serveur. Le serveur commandé est prêt en quelques minutes sans intervention.
4. Suppression : Paramètres > Serveurs > « Supprimer » sur un serveur sans site (admin, saisie du nom pour confirmer). L'instance, ses volumes et son IP sont supprimés ; la facturation s'arrête. Un serveur ajouté à la main est seulement retiré de la liste.
5. Le pare-feu `ufw` du script d'installation limite l'exposition aux ports 22, 80 et 443 ; le groupe de sécurité Scaleway par défaut est conservé.

## GitHub (phase 5)

1. Créer l'organisation GitHub (ex. `auscii`) si ce n'est pas fait.
2. Organisation > Settings > Developer settings > GitHub Apps > New GitHub App : nom « auscii-deploy », webhook désactivé, permissions de dépôt **Contents : Read and write**, **Administration : Read and write**, **Metadata : Read-only**, « Only on this account ». Noter l'**App ID**, générer et télécharger une **clé privée** (PEM).
3. Installer l'App sur l'organisation (tous les dépôts). L'**Installation ID** est le nombre à la fin de l'URL de la page d'installation (`/settings/installations/<id>`).
4. Paramètres > Intégrations > GitHub : organisation, App ID, Installation ID, clé privée, puis « Tester » : l'outil affiche l'App et le nombre de dépôts accessibles.
5. Chaque site provisionné reçoit un dépôt privé `<org>/<slug>`. Chaque zip déposé devient un commit sur `staging` ; la publication place `production` sur ce commit et pose un tag `prod-<date>` ; un retour arrière replace `production` sur l'ancien commit avec un tag `-retour`. Les copies de travail vivent dans `DATA_DIR/git/`.

## Resend (phase 6)

1. Sur resend.com : API Keys > Create API Key, permission **Full access** (l'outil gère les domaines). Copier la clé dans Paramètres > Intégrations > Resend. L'expéditeur est facultatif : par défaut `<Agence> <no-reply@<domaine technique>>`.
2. « Configurer le domaine d'envoi » : l'outil déclare le domaine technique chez Resend (région `eu-west-1`), écrit les enregistrements SPF et DKIM dans LiveDNS si Gandi est configuré (sinon ils sont affichés à créer à la main), puis demande la vérification. Relancer le bouton après quelques minutes jusqu'à l'état « vérifié ». « Tester » affiche l'état du domaine.
3. « Envoyer un email de test » envoie un message à l'adresse de l'admin connecté.
4. Paramètres > Agence > Email des alertes : destinataire des alertes (domaine qui expire sous 30 jours, HTTPS en échec, déploiement en erreur). Une alerte par sujet et par jour.
5. Les messages des formulaires sont enregistrés avant tout envoi. En cas de panne Resend, le worker réessaie pendant plusieurs heures ; un message toujours « non transmis » sur la page du site peut être renvoyé d'un clic.
6. Limite de débit des formulaires : 5 messages par site et par IP toutes les 10 minutes, en mémoire du processus `app` (suffisant pour un pilote à une instance).

## Anthropic (phase 7)

1. Sur console.anthropic.com : API Keys > Create Key. Copier la clé dans Paramètres > Intégrations > Anthropic, puis « Tester » : l'outil affiche le modèle utilisé et sa fenêtre de contexte. Le champ « Modèle » est facultatif (`claude-opus-5` par défaut).
2. À chaque dépôt de zip, le worker envoie le texte des pages (40 pages et 80 000 caractères maximum) et les constats de l'analyse automatique, et reçoit un rapport JSON validé : résumé, SEO, accessibilité, contenu. Le rapport n'est jamais bloquant.
3. Sans clé, l'étape 3 affiche « Rapport Claude non généré » ; après saisie de la clé, « Relancer l'analyse » régénère le rapport de la version en cours. Même bouton après une erreur (limite de débit, indisponibilité).
4. Coût indicatif : un site vitrine de 10 pages représente quelques dizaines de milliers de tokens en entrée, soit quelques centimes par rapport.

## Checklist de validation de la phase 7

1. Intégration Anthropic testée avec succès.
2. Dépôt d'un zip : rapport « Claude (claude-opus-5) » affiché à l'étape 3 en moins d'une minute, avec des constats propres au site.
3. Clé retirée puis zip déposé : rapport « non généré » ; clé remise puis « Relancer l'analyse » : rapport réel.

## Checklist de validation de la phase 6

1. Intégration Resend testée, domaine technique « vérifié ».
2. Email de test reçu.
3. Message envoyé depuis le formulaire d'un site en préproduction : le serveur du site le relaie vers `https://<PILOT_HOST>/api/forms` avec son secret `X-Auscii-Relay` ; il est reçu à l'adresse du site et visible sur sa page. Un `POST` direct sur `/api/forms` sans ce secret est refusé.
4. Alerte reçue après un déploiement forcé en erreur (ou un domaine dont l'expiration est proche).
5. Étape 3 : un zip dont le formulaire ne pointe pas vers `/__forms/contact` est corrigé par le bouton, l'analyse repasse au vert.

## Checklist de validation de la phase 5

1. Intégration GitHub testée avec succès.
2. Provisioning d'un site : dépôt privé créé dans l'organisation.
3. Dépôt d'un zip puis préproduction : commit visible sur `staging`.
4. Publication : branche `production` et tag visibles ; retour arrière : `production` recule et un tag `-retour` apparaît.

## Checklist de validation de la phase 4

1. Clé IAM testée avec succès depuis l'outil.
2. Commande d'un `DEV1-S` depuis Paramètres > Serveurs : passage à « Prêt » sans intervention, métriques visibles.
3. Déploiement d'un site sur ce serveur (préproduction puis production).
4. Suppression du serveur depuis l'outil une fois vidé ; vérification dans la console Scaleway qu'il ne reste ni instance, ni volume, ni IP.

## Checklist de validation de la phase 3

1. Jeton testé avec succès, contact propriétaire enregistré.
2. Étape 1 du wizard : vérification de disponibilité réelle avec prix, suggestions d'extensions.
3. Achat d'un domaine de test peu cher après confirmation ; la console affiche la commande, l'enregistrement et le renouvellement automatique ; la date d'expiration apparaît.
4. DNS créés automatiquement (apex, www, préproduction) ; HTTPS émis sur la préproduction puis la production.

## Checklist de validation de la phase 2

1. Clés SSH générées, serveur ajouté et « Prêt », métriques visibles.
2. Site créé avec un domaine que vous contrôlez, enregistrements DNS créés selon la page du site.
3. Zip déposé, préproduction déployée, lien secret ouvert en HTTPS (`https://<nom de préproduction>/__preview/<token>`), page « Accès réservé » sans le cookie.
4. Publication en production, HTTPS valide sur le domaine et `www`, capture d'écran sur le tableau de bord.
5. Nouveau zip, mise à jour, puis retour à la version précédente : le site bascule instantanément.

## Incidents

| Symptôme                                               | Cause probable                                          | Que faire                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le pilote répond « certificat invalide »               | `deploy.<domaine>` ne pointe pas encore vers le serveur | `dig +short deploy.<domaine>` ; corriger l'enregistrement `A`, puis `docker compose restart caddy`                                                                                                                |
| Un site client reste en « préproduction » sans HTTPS   | DNS non propagé vers le serveur du site                 | Page du site > carte DNS : vérifier les trois enregistrements attendus ; Caddy émet le certificat dans la minute qui suit la propagation                                                                          |
| Déploiement bloqué en « en cours »                     | Worker arrêté ou serveur injoignable                    | `docker compose logs worker` ; relancer le déploiement depuis la page du site (les pipelines reprennent à l'étape échouée)                                                                                        |
| « Serveur injoignable » sur un serveur de sites        | SSH filtré, serveur éteint, clé changée                 | Paramètres > Serveurs > « Retester » ; vérifier l'IP et le pare-feu chez Scaleway                                                                                                                                 |
| Un site en ligne est cassé après publication           | Version fautive                                         | Page du site > « Revenir à la version précédente » : bascule immédiate, `production` recule aussi sur GitHub                                                                                                      |
| Messages de formulaire non transmis                    | Resend indisponible ou domaine d'envoi non vérifié      | Page du site : badge « non transmis » et bouton « Renvoyer » ; Paramètres > Intégrations > Resend > « Tester »                                                                                                    |
| Rapport Claude « indisponible »                        | Limite de débit ou clé invalide                         | Étape 3 > « Relancer l'analyse » ; sinon vérifier la clé                                                                                                                                                          |
| Disque plein sur le pilote                             | Anciennes images, archives des versions, sauvegardes    | `./prune-images.sh` (garde le tag courant et le précédent ; **jamais** `docker system prune -a`, qui supprime l'image du retour arrière), `docker system df`, taille de `/backups` ; augmenter le volume Scaleway |
| Le pilote ne redémarre pas après une mise à jour       | Migration ou image fautive                              | `update.sh` revient seul au tag précédent et propose de restaurer la base ; sinon `docker compose logs migrate app`, `./restore.sh db-<date>.sql.gz` (dossier `pre-update/`) puis `./update.sh <tag précédent>`   |
| `app` redémarre en boucle, « configuration invalide »  | `.env` incomplet ou valeur d'exemple                    | `docker compose logs app` donne la variable en cause ; corriger `.env` puis `docker compose up -d`                                                                                                                |
| Service `backup` « unhealthy » ou alerte de sauvegarde | Dump en échec, envoi S3 en échec, disque plein          | `docker compose exec backup cat /backups/status`, `tail /backups/backup.log` ; clés S3 et `BACKUP_AGE_RECIPIENT` ; relancer `docker compose run --rm backup run`                                                  |
| Aperçu vide ou refusé à l'étape 3                      | `PREVIEW_APP_HOST` ne résout pas, ou certificat absent  | `dig +short <PREVIEW_APP_HOST>` ; `docker compose logs caddy`                                                                                                                                                     |

Journaux : `docker compose logs -f app worker caddy` (conservés 5 × 20 Mo par conteneur). État de santé : `curl -fsS https://<PILOT_HOST>/api/health`.

## Limites connues

- Le limiteur de débit des formulaires (5 messages par site et par IP toutes les 10 minutes) vit en mémoire du conteneur `app`. Le pilote tourne à une seule instance, donc la limite est effective ; elle se réinitialise à chaque redémarrage.
- L'image du worker embarque Chromium : elle pèse environ 800 Mo. Le premier `docker compose pull` prend quelques minutes.
- Les versions déposées (`releases/`) ne sont pas encore purgées sur le pilote : elles grossissent le disque et chaque archive de sauvegarde.
- `backup.sh` garde ses sauvegardes sur le disque du pilote : sans Object Storage, la perte du VPS les emporte.
