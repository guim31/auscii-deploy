# Pilote (hébergement de l'outil)

Pile Docker du serveur qui héberge auscii-deploy lui-même. La procédure complète
(prérequis, variables, mise à jour, sauvegardes, reprise après sinistre,
incidents) est dans `docs/runbook.md`.

| Fichier              | Rôle                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `docker-compose.yml` | Base, migrations, application, worker, Caddy, sauvegardes                           |
| `Caddyfile.pilot`    | HTTPS automatique, outil et aperçus sur deux domaines, limites de taille des envois |
| `.env.example`       | Modèle de configuration commenté ; `install.sh` en fait un `.env` avec des secrets  |
| `install.sh`         | Installation à blanc sur un VPS Debian 12 neuf, ou reprise avec un `.env` existant  |
| `update.sh`          | Mise à jour vers un SHA publié, fichiers de la pile compris, avec retour arrière    |
| `restore.sh`         | Restauration d'une sauvegarde locale ou d'Object Storage                            |
| `prune-images.sh`    | Libère le disque en gardant les images du tag courant et du précédent               |
| `backup.sh`          | Point d'entrée de l'image de sauvegarde : planification, sauvegarde, sonde de santé |
| `lib.sh`             | Fonctions communes des scripts (lecture et écriture sûres du `.env`, attentes)      |
| `smoke-test.sh`      | Test de fumée de la pile sur des images construites, lancé par la CI                |

Les images sont construites depuis le `Dockerfile` à la racine et publiées par la
CI sur `ghcr.io/<org>/` avec le SHA court du commit pour étiquette :
`auscii-deploy-app` (Next.js autonome), `auscii-deploy-worker` (jobs, migrations,
avec `git` et Chromium) et `auscii-deploy-backup` (PostgreSQL client, age,
aws-cli).

Le fichier `.env` porte les secrets du pilote : il reste en `chmod 600`, lisible
par root uniquement, n'est jamais versionné, et une copie complète va dans le
coffre de l'agence. Les clés des intégrations (Gandi, Scaleway, GitHub, Resend,
Anthropic) ne sont pas ici : elles se saisissent dans l'interface et sont
chiffrées en base.
