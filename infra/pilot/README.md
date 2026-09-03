# Pilote (hébergement de l'outil)

Pile Docker du serveur qui héberge auscii-deploy lui-même. La procédure complète,
avec les prérequis et les incidents, est dans `docs/runbook.md`.

| Fichier              | Rôle                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `docker-compose.yml` | Base, migrations, application, worker, Caddy, sauvegardes                 |
| `Caddyfile.pilot`    | HTTPS automatique, en-têtes de sécurité, limite de taille des envois      |
| `.env.example`       | Modèle de configuration ; `install.sh` en fait un `.env` avec des secrets |
| `install.sh`         | Installation à blanc sur un VPS Debian 12 neuf                            |
| `update.sh`          | Mise à jour vers un tag publié, avec retour arrière automatique           |
| `backup.sh`          | Sauvegarde nocturne (base + fichiers), rotation, envoi S3                 |
| `restore.sh`         | Restauration depuis une sauvegarde                                        |

Les images sont construites et publiées par la CI sur `ghcr.io` :
`auscii-deploy-app` (Next.js autonome) et `auscii-deploy-worker` (jobs, avec le
binaire `git` et Chromium pour les captures).

Le fichier `.env` porte les secrets du pilote : il reste en `chmod 600`, lisible
par root uniquement, et n'est jamais versionné. Les clés des intégrations (Gandi,
Scaleway, GitHub, Resend, Anthropic) ne sont pas ici : elles se saisissent dans
l'interface et sont chiffrées en base.
