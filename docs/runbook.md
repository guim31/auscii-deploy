# Runbook (exploitation)

Ce document sera complété au fil des phases. Il fixe dès maintenant les prérequis et la cible d'installation.

## Prérequis côté agence

| Service           | À préparer                                                                                                                                      | Utilisé pour                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Scaleway          | Projet, clé API (Instances), zone par défaut                                                                                                    | Commande des VPS sites                                    |
| Gandi             | Compte avec moyen de paiement, clé API (PAT) avec droits domaine et LiveDNS, organisation propriétaire par défaut                               | Achat de domaines, DNS                                    |
| Domaine technique | Un domaine dédié acheté chez Gandi (ex. `auscii.site`). `auscii.com` reste chez OVH avec les emails et n'est jamais modifié                     | Outil (`deploy.…`) et préproductions (`client.preview.…`) |
| GitHub            | Une organisation AUSCII et une GitHub App installée dessus (permissions : contents et administration des dépôts). Aucun compte pour les gérants | Un repo par site                                          |
| Resend            | Compte et clé API (accès complet). Le domaine d'envoi est le domaine technique, déclaré et vérifié depuis l'outil                               | Formulaires, alertes                                      |
| Anthropic         | Clé API (console.anthropic.com). Modèle `claude-opus-5` par défaut, modifiable dans Paramètres > Intégrations                                   | Rapport de relecture à l'étape 3                          |

## Pilote (hébergement de l'outil)

- Un VPS Scaleway dédié, Debian 12, 2 vCPU / 4 Go et 40 Go de disque recommandés (les archives des sites s'accumulent).
- Pile Docker Compose dans `infra/pilot/` : `db` (PostgreSQL 16), `migrate` (migrations et premier admin, s'arrête), `app` (Next.js autonome), `worker` (jobs, avec `git` et Chromium), `caddy` (HTTPS automatique), `backup` (sauvegarde nocturne).
- Images publiées par la CI sur `ghcr.io/<org>/auscii-deploy-app` et `-worker`, étiquetées par SHA court et `latest`.
- Configuration dans `/opt/auscii-deploy/.env` (chmod 600) : `PILOT_HOST`, `ACME_EMAIL`, `IMAGE_TAG`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, le premier compte admin et les identifiants Object Storage. Les clés des intégrations ne sont pas là : elles se saisissent dans l'interface et sont chiffrées en base.
- Clé SSH du pilote générée depuis Paramètres > Intégrations, stockée chiffrée en base, clé publique affichée pour les scripts d'installation des serveurs de sites.
- Sauvegardes : dump Postgres et archive des fichiers chaque nuit, rotation locale (7 quotidiennes, 4 hebdomadaires) et copie vers Scaleway Object Storage.

### Installation à blanc

Prérequis : un VPS Debian 12 neuf, un enregistrement `A` `deploy.<domaine technique>` qui pointe vers son IP publique (le certificat ne peut pas être émis sans), et un accès root en SSH.

```bash
apt-get update && apt-get install -y git
git clone https://github.com/<org>/auscii-deploy /tmp/auscii-deploy
bash /tmp/auscii-deploy/infra/pilot/install.sh
```

Le script installe Docker, copie la pile dans `/opt/auscii-deploy`, demande le nom d'hôte, l'email Let's Encrypt et le premier compte administrateur, tire les secrets au hasard, durcit le système (pare-feu limité à 22, 80 et 443, `fail2ban`, mises à jour automatiques, mot de passe SSH désactivé), récupère les images, applique les migrations et démarre la pile. Il se termine en attendant que l'application soit saine.

Si les images sont privées, se connecter à GHCR avant de lancer le script :

```bash
export GHCR_USER=<votre-compte> GHCR_TOKEN=<jeton avec read:packages>
```

Ensuite, dans l'interface : Paramètres > Agence (domaine technique, contact propriétaire, email des alertes), Paramètres > Intégrations (clés des cinq services, puis « Tester »), et génération de la paire de clés SSH du pilote.

### Mise à jour

```bash
cd /opt/auscii-deploy
./update.sh 3f8a1c2   # SHA court affiché par la CI, ou "latest"
```

Le script sauvegarde, récupère les images, applique les migrations, redémarre et attend la santé de l'application. Si elle ne repart pas, il revient automatiquement au tag précédent. Les déploiements de sites en cours au moment de la mise à jour sont repris par le worker au redémarrage : les pipelines reprennent à l'étape où ils s'étaient arrêtés.

### Sauvegardes et restauration

La sauvegarde tourne chaque nuit à l'heure de `BACKUP_HOUR`. À la demande :

```bash
cd /opt/auscii-deploy
docker compose run --rm --entrypoint /usr/local/bin/backup.sh backup
docker compose --profile tools run --rm --entrypoint sh restore -c 'ls -1t /backups/daily'
```

Restauration (arrête l'application, remplace les données, redémarre) :

```bash
./restore.sh db-20260903-030000.sql.gz data-20260903-030000.tar.gz
```

Depuis Object Storage, rapatrier d'abord l'archive puis la déposer dans le volume :

```bash
aws --endpoint-url https://s3.fr-par.scw.cloud s3 cp s3://<bucket>/2026/09/db-20260903-030000.sql.gz .
docker compose cp db-20260903-030000.sql.gz backup:/backups/daily/
```

### Rotation d'une clé

- **Clé d'une intégration** (Gandi, Scaleway, GitHub, Resend, Anthropic) : Paramètres > Intégrations, coller la nouvelle valeur, « Enregistrer », puis « Tester ». L'ancienne est écrasée en base ; révoquer ensuite chez le fournisseur.
- **Clé SSH du pilote** : générer une nouvelle paire dans Paramètres > Intégrations, ajouter la nouvelle clé publique dans `/home/deploy/.ssh/authorized_keys` de chaque serveur de sites **avant** de retirer l'ancienne, vérifier avec « Retester » sur chaque serveur.
- **`APP_ENCRYPTION_KEY`** : ne peut pas être changée sans réécrire les secrets chiffrés. Procédure : noter les clés des intégrations, vider la table `Integration`, changer la variable dans `.env`, redémarrer, ressaisir les clés.
- **`BETTER_AUTH_SECRET`** : la changer déconnecte tout le monde, sans autre conséquence.

## Développement local

```bash
cp .env.example .env          # puis adapter APP_ENCRYPTION_KEY et BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d db        # PostgreSQL 16
pnpm install
pnpm db:migrate                # migrations Prisma
pnpm db:seed                   # premier compte admin (ADMIN_EMAIL / ADMIN_PASSWORD)
pnpm dev                       # app sur http://localhost:3000 + worker
```

Avec `DEMO_MODE=true`, tout le parcours fonctionne sans aucune clé API ni réseau sortant.

Tests : `pnpm test` (Vitest, base `DATABASE_URL_TEST` si définie), `pnpm e2e` (Playwright, démarre l'app et le worker en mode démo).

## Ajouter un serveur existant (phase 2)

1. Paramètres > Intégrations > SSH : **Générer une paire de clés** (ou importer une clé privée OpenSSH existante). La clé publique s'affiche.
2. Créer un VPS Debian 12 (Scaleway DEV1-S conseillé) avec un accès root.
3. Paramètres > Serveurs > **Ajouter un serveur existant** : copier le script affiché (il contient la clé publique), le lancer en root sur le VPS (`bash bootstrap.sh`). Il installe Caddy, Docker, le pare-feu, l'utilisateur `deploy` et pose le marqueur `/var/lib/auscii-ready`.
4. Renseigner le nom, l'IP et valider. L'outil attend le marqueur, mémorise l'empreinte de la clé d'hôte (vérifiée à chaque connexion) et relève les métriques. Le serveur passe à « Prêt ».
5. En cas d'erreur : « Retester ». Après une réinstallation du serveur : « Oublier la clé d'hôte » puis retester.

## DNS manuel (sans Gandi)

Tant que l'intégration Gandi n'est pas configurée, le wizard force « domaine déjà possédé » et le provisioning ignore l'achat et le DNS. La page du site affiche les trois enregistrements `A` à créer chez le registrar : l'apex et `www` du domaine client, et `<slug>.preview.<domaine technique>`. Caddy émet le certificat HTTPS dès que le nom résout vers le serveur. Le relais des formulaires (`/__forms/*`) suppose un pilote joignable publiquement (`deploy.<domaine technique>`), ce qui sera le cas après la phase 8.

## Gandi (phase 3)

1. Sur gandi.net : Paramètres du compte > Sécurité > Jetons d'accès personnels. Créer un jeton lié à l'organisation qui portera les domaines, avec les droits ci-dessus. Le copier dans Paramètres > Intégrations > Gandi, puis « Tester » : l'outil affiche le compte et l'organisation.
2. Paramètres > Agence : renseigner l'identifiant d'organisation (affiché par le test) et le contact propriétaire complet (raison sociale, prénom, nom, email, téléphone au format `+33.612345678`, adresse, code postal, ville, pays). Gandi refuse tout achat avec un contact incomplet ; l'outil le vérifie à blanc (`Dry-Run`) avant de facturer.
3. Chaque achat active le renouvellement automatique. Un job quotidien rafraîchit la date d'expiration ; le tableau de bord signale un domaine à moins de 30 jours sans renouvellement automatique.
4. Le domaine technique (`auscii.site` ou autre) doit être chez Gandi avec LiveDNS pour que les enregistrements de préproduction soient créés automatiquement.

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
3. Message posté sur `/api/forms` (avec l'en-tête `X-Site: <slug>`) reçu à l'adresse du site et visible sur sa page ; en local sans pilote public : `curl -X POST -H "X-Site: <slug>" -d "nom=Test&email=test@example.com&message=Bonjour" http://localhost:3000/api/forms`.
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
3. Zip déposé, préproduction déployée, lien secret ouvert en HTTPS (`https://<slug>.preview.<tech>/__preview/<token>`), page « Accès réservé » sans le cookie.
4. Publication en production, HTTPS valide sur le domaine et `www`, capture d'écran sur le tableau de bord.
5. Nouveau zip, mise à jour, puis retour à la version précédente : le site bascule instantanément.

## Incidents

| Symptôme                                             | Cause probable                                          | Que faire                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Le pilote répond « certificat invalide »             | `deploy.<domaine>` ne pointe pas encore vers le serveur | `dig +short deploy.<domaine>` ; corriger l'enregistrement `A`, puis `docker compose restart caddy`                                       |
| Un site client reste en « préproduction » sans HTTPS | DNS non propagé vers le serveur du site                 | Page du site > carte DNS : vérifier les trois enregistrements attendus ; Caddy émet le certificat dans la minute qui suit la propagation |
| Déploiement bloqué en « en cours »                   | Worker arrêté ou serveur injoignable                    | `docker compose logs worker` ; relancer le déploiement depuis la page du site (les pipelines reprennent à l'étape échouée)               |
| « Serveur injoignable » sur un serveur de sites      | SSH filtré, serveur éteint, clé changée                 | Paramètres > Serveurs > « Retester » ; vérifier l'IP et le pare-feu chez Scaleway                                                        |
| Un site en ligne est cassé après publication         | Version fautive                                         | Page du site > « Revenir à la version précédente » : bascule immédiate, `production` recule aussi sur GitHub                             |
| Messages de formulaire non transmis                  | Resend indisponible ou domaine d'envoi non vérifié      | Page du site : badge « non transmis » et bouton « Renvoyer » ; Paramètres > Intégrations > Resend > « Tester »                           |
| Rapport Claude « indisponible »                      | Limite de débit ou clé invalide                         | Étape 3 > « Relancer l'analyse » ; sinon vérifier la clé                                                                                 |
| Disque plein sur le pilote                           | Archives des versions accumulées                        | `docker system prune -a` puis supprimer les anciennes versions inutiles ; augmenter le volume Scaleway                                   |
| Le pilote ne redémarre pas après une mise à jour     | Migration ou image fautive                              | `update.sh` revient seul au tag précédent ; sinon `./update.sh <tag précédent>`                                                          |

Journaux : `docker compose logs -f app worker caddy`. État de santé : `curl -fsS https://<pilote>/api/health`.

## Limites connues

- Le limiteur de débit des formulaires (5 messages par site et par IP toutes les 10 minutes) vit en mémoire du conteneur `app`. Le pilote tourne à une seule instance, donc la limite est effective ; elle se réinitialise à chaque redémarrage.
- L'image du worker embarque Chromium : elle pèse environ 800 Mo. Le premier `docker compose pull` prend quelques minutes.
