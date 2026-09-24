# auscii-deploy

Outil web interne d'AUSCII pour publier des sites vitrine statiques sur des VPS Scaleway, avec domaine Gandi, repo GitHub par site, préproduction puis production. Utilisateurs : gérants non techniciens. UX minimale, système complet derrière.

**La v1 est développée** (phases 0 à 8) mais **pas encore en production** : le pilote n'a jamais été installé et les comptes réels (Scaleway, GitHub, Gandi, Resend, Anthropic) arrivent. Une passe de corrections avant mise en service a suivi l'audit de septembre 2026 ; la mise en service se fait en suivant la checklist de validation de `docs/runbook.md`. La v2 commence à la phase 9 : l'espace client de relecture.

## Lire d'abord

- `docs/scope-v2.md` : décisions de la v2, en cours. Ne pas élargir sans accord.
- `docs/scope-v1.md` : périmètre livré en v1, il fait foi sur l'existant.
- `docs/architecture.md` : stack, adaptateurs, modèle de données, pipeline.
- `docs/roadmap.md` : phase en cours et critère de fin.
- `docs/runbook.md` : exploitation du pilote, incidents, sauvegardes.

## Règles

- Langue de l'interface et des messages utilisateur : français. Code, identifiants et commits : anglais.
- Toute intégration externe passe par une interface `*Provider` dans `src/server/providers/` avec une implémentation réelle et un mock. Le mode démo doit toujours fonctionner sans réseau.
- Les actions payantes (achat de domaine, commande de serveur) exigent une confirmation explicite en UI, le rôle `admin`, et une entrée `AuditLog`. La confirmation est enregistrée sur le `Deployment` (`serverOrderConfirmedById`, `domainPurchaseConfirmedById`, prix maximal) : une relance réutilise celle-ci et ne peut jamais la créer. Le prix est revérifié côté serveur, jamais repris du navigateur.
- Tout ce qui commande ou achète est idempotent : la ligne en base (`Server` en `ordering`, `Domain` en `ordering`) existe avant l'appel au fournisseur, et une reprise retrouve la ressource au lieu d'en payer une deuxième.
- Un job choisit mocks ou intégrations réelles d'après l'entité traitée (`getProviders({ demo: site.isDemo })`), jamais d'après le mode affiché à l'écran. Une action refuse un objet de l'autre mode (`matchesCurrentMode`).
- Les secrets ne quittent jamais le serveur : chiffrés en base, jamais dans les réponses API ni dans les logs.
- Les jobs de déploiement sont idempotents et journalisent chaque étape dans `DeploymentLog`.
- Tout ce qui est joignable depuis un site client (`/__forms/*`, bientôt `/__review/*`) est une entrée non fiable : taille bornée, limite de débit, affichage comme du texte et jamais comme du HTML, et jamais exécuté dans l'origine de l'outil. Le relais est authentifié par un secret par site (`src/server/deploy/relay.ts`), posé par le bloc Caddy du site.
- Le contenu des sites clients ne s'exécute jamais sur le domaine de l'outil : les préproductions vivent sur un domaine enregistrable distinct (réglage « domaine des préproductions »), et l'aperçu de l'étape 3 est servi par `/apercu/<jeton signé>/` sur `PREVIEW_ORIGIN`.
- Contrat des routes relayées par Caddy : toute modification passe par les blocs générés dans `src/server/deploy/caddy.ts` et leurs tests ; les blocs déjà écrits sur les serveurs sont régénérés au déploiement suivant de chaque site.
- Migrations Prisma : toujours additives et compatibles avec la version précédente de l'application (Prisma n'a pas de migration descendante ; le retour arrière d'une mise à jour passe par la restauration de la sauvegarde prise juste avant, voir `infra/pilot/update.sh`).
- La préproduction et la production sont **deux copies distinctes** sur le serveur (`/srv/sites/<slug>--preview/` et `/srv/sites/<slug>/`) : un contenu propre à la préproduction est possible, et ne doit jamais fuiter en production.
- Le runtime de site est une abstraction (`SiteRuntime`) ; `static` reste la seule implémentation, le runtime `docker` est repoussé. Ne pas coupler le wizard ou le dashboard à ce choix.
- Pas de dépendance à VitoDeploy. Les VPS sites ne reçoivent que Caddy, Docker et les fichiers des sites, pilotés par SSH.

## Commandes

- `pnpm dev` : app + worker en local, Postgres via `docker compose up -d db`. `pnpm db:migrate`, `pnpm db:seed` (lit `.env`, admin avec un mot de passe de 12 caractères minimum).
- `pnpm test` : Vitest (unitaires + pipelines). Les tests base de données exigent `DATABASE_URL_TEST`, une base distincte de `DATABASE_URL` : ils suppriment les données de démo.
- `pnpm e2e` : Playwright en mode démo sur `next dev` (démarre app et worker) ; `pnpm e2e:build` (et la CI) sur le build de production.
- Pilote : trois images (`app`, `worker`, `backup`) étiquetées au SHA court du commit ; `infra/pilot/smoke-test.sh` démarre la pile et la vérifie, la CI le lance avant toute publication.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` : à passer avant tout commit.

## Repères dans le code

- `src/server/providers/` : interfaces (`types.ts`), mocks, coquilles réelles, fabrique `getProviders()`.
- `src/server/jobs/` : pg-boss (`boss.ts`), runner de pipeline avec reprise par étape (`pipeline.ts`), pipelines (`pipelines.ts`), handlers du worker.
- `src/server/capacity.ts` : placement des sites par métriques, pur et testé.
- `src/server/releases/` : extraction sécurisée du zip, analyse statique, correction des formulaires.
- `src/server/deploy/` : agent SSH, blocs Caddy générés par site (`caddy.ts`), runtimes (`runtime.ts`), DNS, contrôle TLS, script d'installation des serveurs.
- `src/server/jobs/mail.ts` et `alerts.ts` : file d'envoi avec reprise, et alertes à l'agence dédoublonnées par sujet et par jour.
- `infra/pilot/` : pile Docker du pilote et scripts d'exploitation (installation, mise à jour, sauvegarde, restauration).
- `src/server/actions/` : server actions appelées par l'UI ; toute action payante y écrit un `AuditLog`.
- `src/components/wizard/` : les 4 étapes ; `deploy-console.tsx` consomme le flux SSE.
- Next 16 : `src/proxy.ts` remplace `middleware.ts`, `params` et `searchParams` sont des promesses.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
