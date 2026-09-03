# Feuille de route

Chaque phase est une pull request testable indépendamment.

| Phase | Livrable                                                                                                                    | Critère de fin                                     | État    |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| 0     | Documents de cadrage (`docs/`, `CLAUDE.md`)                                                                                 | Validés, aucun code                                | Fait    |
| 1     | Squelette Next.js, Prisma, auth, layout, parcours complet en **mode démo** (dashboard, wizard 4 étapes, console SSE, mocks) | Démo cliquable identique au futur réel             | Fait    |
| 2     | Déploiement réel SSH + Caddy sur un VPS existant : staging, production, rollback, captures Playwright, contrôle HTTPS       | Un site statique en ligne en HTTPS depuis l'outil  | Fait    |
| 3     | Gandi réel : vérification, achat avec confirmation, LiveDNS (production et preview)                                         | Domaine acheté et pointé depuis l'outil            | Fait    |
| 4     | Scaleway réel : commande automatique, cloud-init, gestion de capacité                                                       | Nouveau serveur commandé et prêt sans intervention | Fait    |
| 5     | GitHub réel (GitHub App sur l'organisation) : repo par site, promotion, tags                                                | Historique visible sur GitHub                      | Fait    |
| 6     | Resend réel pour les formulaires et notifications                                                                           | Email reçu depuis un site en production            | Fait    |
| 7     | Analyse Claude API à l'étape 3                                                                                              | Rapport réel affiché                               | Fait    |
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

## Ce que la phase 3 contient

- `GandiProvider` réel sur l'API v5 : disponibilité et prix, achat validé à blanc puis exécuté, suivi jusqu'à l'enregistrement, renouvellement automatique, LiveDNS, liste des domaines, test du jeton.
- Contact propriétaire complet dans Paramètres > Agence (l'agence est propriétaire des domaines).
- Job quotidien `domain.refresh` et alerte d'expiration sur le tableau de bord.
- Tests sur réponses simulées de l'API, test live optionnel en lecture seule (`TEST_GANDI_TOKEN`).

## Ce que la phase 4 contient

- `ScalewayProvider` réel : offres et disponibilité, création d'une instance Debian 12 avec IP publique routée, cloud-init et démarrage, suivi de l'état, suppression idempotente (instance, volumes, IP), test de la clé et du projet.
- Suppression d'un serveur vide depuis l'outil (admin, confirmation par saisie du nom, audit, file `server.delete`).
- Contrôle de la clé SSH du pilote avant toute commande.

## Ce que la phase 5 contient

- `GitHubProvider` réel : authentification GitHub App (JWT puis jeton d'installation en cache), dépôt privé par site idempotent, commits sur `staging` via le binaire `git`, `production` et tag à la publication, retour arrière qui replace `production`, test de l'App.
- Le jeton ne reste jamais dans la configuration Git locale ni dans les logs.

## Ce que la phase 6 contient

- `ResendProvider` réel : envoi transactionnel, gestion du domaine d'envoi (déclaration, enregistrements SPF/DKIM écrits dans LiveDNS quand Gandi est configuré, vérification), test de la clé.
- File `mail.send` avec reprise : la route `/api/forms` enregistre le message et répond immédiatement, le worker envoie l'email et marque `emailedAt` ; un message non transmis est signalé sur la page du site avec un bouton « Renvoyer ».
- Alertes à l'agence (`Alert`, une par sujet et par jour) : domaine qui expire sous 30 jours, contrôle HTTPS en échec, déploiement en erreur. Adresse dans Paramètres > Agence.
- Bouton « Corriger les formulaires » à l'étape 3 : réécrit `action`, `method="post"` et ajoute le champ honeypot dans la release, puis relance l'analyse.
- Les envois en préproduction sont marqués comme tels (en-tête `X-Site-Env`).

## Ce que la phase 7 contient

- `AnthropicProvider` réel via le SDK officiel : rapport structuré (résumé, SEO, accessibilité, contenu) demandé en sortie JSON validée, modèle `claude-opus-5` par défaut et modifiable dans les paramètres, budget d'entrée borné (40 pages, 80 000 caractères), test de la clé et du modèle.
- Le rapport reçoit les constats de l'analyse automatique pour les compléter plutôt que les répéter. Un refus ou une erreur donne un rapport « indisponible » avec un bouton « Relancer l'analyse » à l'étape 3 ; sans clé, le rapport indique quoi configurer.
- Erreurs traduites (clé invalide, modèle inconnu, limite de débit, indisponibilité), clé jamais journalisée.

## Prérequis à réunir avant la phase 2

- Un domaine technique acheté chez Gandi (ex. `auscii.site`) et saisi dans Paramètres > Agence.
- Un VPS de test Scaleway (DEV1-S, Debian 12) accessible en SSH pour valider le déploiement réel.
- Une organisation GitHub AUSCII avec une GitHub App installée (phase 5).

## Idées v2

- Runtime `docker` pour les sites dynamiques (Node, PHP).
- Génération du site depuis un brief dans l'outil.
- Espace client de relecture avec commentaires sur la préproduction.
- Multi-registrar, multi-cloud.
