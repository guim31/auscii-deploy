# Feuille de route

Chaque phase est une pull request testable indépendamment.

| Phase | Livrable                                                                                                                    | Critère de fin                                     | État    |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| 0     | Documents de cadrage (`docs/`, `CLAUDE.md`)                                                                                 | Validés, aucun code                                | Fait    |
| 1     | Squelette Next.js, Prisma, auth, layout, parcours complet en **mode démo** (dashboard, wizard 4 étapes, console SSE, mocks) | Démo cliquable identique au futur réel             | Fait    |
| 2     | Déploiement réel SSH + Caddy sur un VPS existant : staging, production, rollback, captures Playwright, contrôle HTTPS       | Un site statique en ligne en HTTPS depuis l'outil  | À faire |
| 3     | Gandi réel : vérification, achat avec confirmation, LiveDNS (production et preview)                                         | Domaine acheté et pointé depuis l'outil            | À faire |
| 4     | Scaleway réel : commande automatique, cloud-init, gestion de capacité                                                       | Nouveau serveur commandé et prêt sans intervention | À faire |
| 5     | GitHub réel (GitHub App sur l'organisation) : repo par site, promotion, tags                                                | Historique visible sur GitHub                      | À faire |
| 6     | Resend réel pour les formulaires et notifications                                                                           | Email reçu depuis un site en production            | À faire |
| 7     | Analyse Claude API à l'étape 3                                                                                              | Rapport réel affiché                               | À faire |
| 8     | Docker Compose du pilote, runbook complet, durcissement, e2e                                                                | Installation reproductible sur un VPS neuf         | À faire |

## Ce que la phase 1 contient

- Toute l'architecture : Next.js 16, Prisma, PostgreSQL, better-auth, pg-boss, worker, adaptateurs réel/mock, chiffrement des secrets.
- Le parcours complet en mode démo : connexion, wizard 4 étapes, console temps réel, dépôt et analyse d'un vrai `.zip`, prévisualisation, préproduction, production, tableau de bord, page site avec historique, retour arrière et messages, paramètres.
- Les coquilles des intégrations réelles (`GandiProvider`, `ScalewayProvider`, `GitHubProvider`, `ResendProvider`, `AnthropicProvider`, `SshServerAgent`) répondent « non configuré » : chaque phase suivante remplit une coquille sans toucher au reste.
- Tests unitaires (chiffrement, capacité, extraction, analyse, Caddy) et d'intégration (pipelines complets contre une base réelle), e2e Playwright en mode démo.

## Vérification

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e`.
- Phases 2 à 7 : tests de contrat des adaptateurs (mock et réel derrière la même suite), puis run réel sur un VPS de test et un domaine de test peu cher, avec checklist : HTTPS valide, rollback, formulaire reçu, commande de serveur annulable.
- Phase 8 : installation à blanc du pilote en suivant uniquement le runbook.

## Ce que la phase 2 contient

- Agent SSH réel (`ssh2`) : connexion avec la clé du pilote et vérification de la clé d'hôte, envoi des releases en `tar.gz`, bascule atomique, configuration Caddy validée avant rechargement, métriques, contrôle TLS.
- Clés SSH générées ou importées depuis l'interface, script d'installation `infra/bootstrap-server.sh` partagé avec le cloud-init de la phase 4, enregistrement d'un serveur existant.
- Captures d'écran Chromium des sites publiés.
- Mode réel partiel : sans Gandi ni GitHub, les étapes correspondantes sont ignorées avec avertissement et les enregistrements DNS attendus sont affichés.

## Prérequis à réunir avant la phase 2

- Un domaine technique acheté chez Gandi (ex. `auscii.site`) et saisi dans Paramètres > Agence.
- Un VPS de test Scaleway (DEV1-S, Debian 12) accessible en SSH pour valider le déploiement réel.
- Une organisation GitHub AUSCII avec une GitHub App installée (phase 5).

## Idées v2

- Runtime `docker` pour les sites dynamiques (Node, PHP).
- Génération du site depuis un brief dans l'outil.
- Espace client de relecture avec commentaires sur la préproduction.
- Multi-registrar, multi-cloud.
