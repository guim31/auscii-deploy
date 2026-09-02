# auscii-deploy

Outil web interne de l'agence AUSCII pour mettre en ligne, en quelques clics, les sites vitrine créés avec Claude Code : choix du domaine, dépôt d'un `.zip`, préproduction, publication.

> État du projet : **phase 3 livrée**. Parcours complet en mode démo, déploiement réel SSH + Caddy, et intégration Gandi réelle (domaines et DNS). Scaleway, GitHub, Resend et Anthropic arrivent dans les phases 4 à 7. Checklists de validation dans `docs/runbook.md`.

## Démarrer

```bash
cp .env.example .env
docker compose up -d db
pnpm install && pnpm db:migrate && pnpm db:seed
pnpm dev
```

Connexion sur http://localhost:3000 avec `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Voir `docs/runbook.md`.

## Documents

| Document                                     | Contenu                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| [docs/concept.md](docs/concept.md)           | Vision et parcours utilisateur                                            |
| [docs/scope-v1.md](docs/scope-v1.md)         | Périmètre fonctionnel détaillé de la v1, hors périmètre, décisions        |
| [docs/architecture.md](docs/architecture.md) | Stack technique, architecture, modèle de données, pipeline de déploiement |
| [docs/runbook.md](docs/runbook.md)           | Exploitation : installation du pilote, prérequis, incidents               |
| [docs/roadmap.md](docs/roadmap.md)           | Phases de réalisation et critères de fin                                  |
| [CLAUDE.md](CLAUDE.md)                       | Conventions pour le développement avec Claude Code                        |

## En une phrase par étape

1. **Domaine** : le gérant saisit le domaine, l'outil vérifie la disponibilité chez Gandi et choisit le serveur.
2. **Provisioning** : commande du serveur si besoin, achat du domaine (après confirmation), DNS, repo GitHub, vhost.
3. **Site** : dépôt du `.zip`, vérification automatique, prévisualisation, rapport Claude.
4. **Mise en ligne** : préproduction sur `client.preview.auscii.fr`, puis publication sur le domaine.
