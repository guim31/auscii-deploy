# Feuille de route

Chaque phase est une pull request testable indépendamment.

| Phase | Livrable | Critère de fin |
|---|---|---|
| 0 | Documents de cadrage (`docs/`, `CLAUDE.md`) | Validés, aucun code |
| 1 | Squelette Next.js, Prisma, auth, layout, parcours complet en **mode démo** (dashboard, wizard 4 étapes, console SSE, mocks) | Démo cliquable identique au futur réel |
| 2 | Déploiement réel SSH + Caddy sur un VPS existant : staging, production, rollback, captures, contrôle HTTPS | Un site statique en ligne en HTTPS depuis l'outil |
| 3 | Gandi réel : vérification, achat avec confirmation, LiveDNS (production et preview) | Domaine acheté et pointé depuis l'outil |
| 4 | Scaleway réel : commande automatique, cloud-init, gestion de capacité | Nouveau serveur commandé et prêt sans intervention |
| 5 | GitHub réel : repo par site, promotion, tags | Historique visible sur GitHub |
| 6 | Formulaires + Resend, messages dans le dashboard | Email reçu depuis un site en production |
| 7 | Analyse Claude API à l'étape 3 | Rapport affiché |
| 8 | Docker Compose du pilote, runbook complet, durcissement, e2e | Installation reproductible sur un VPS neuf |

## Vérification

- Phase 1 : `pnpm test` (Vitest : machine à états, mocks), `pnpm e2e` (Playwright : connexion, wizard complet en démo, site sur le dashboard).
- Phases 2 à 7 : tests de contrat des adaptateurs (mock et réel derrière la même suite), puis run réel sur un VPS de test et un domaine de test peu cher, avec checklist : HTTPS valide, rollback, formulaire reçu, commande de serveur annulable.
- Phase 8 : installation à blanc du pilote en suivant uniquement le runbook.

## À valider avant la phase 1

- Nom de l'organisation GitHub et domaine de preview (`preview.auscii.fr` ?).
- Offre Scaleway par défaut (proposition : la moins chère, type PLAY2 ou DEV1, Debian 12).
- Fournisseur email : Resend (proposition) ou Brevo.
- Limite de sites par serveur (proposition : 25).

## Idées v2

- Runtime `docker` pour les sites dynamiques (Node, PHP).
- Génération du site depuis un brief dans l'outil.
- Espace client de relecture avec commentaires sur la préproduction.
- Multi-registrar, multi-cloud.
