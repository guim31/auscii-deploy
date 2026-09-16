# auscii-deploy

Outil web interne d'AUSCII pour publier des sites vitrine statiques sur des VPS Scaleway, avec domaine Gandi, repo GitHub par site, préproduction puis production. Utilisateurs : gérants non techniciens. UX minimale, système complet derrière.

**La v1 est livrée** (phases 0 à 8) et le pilote tourne en production. La v2 commence à la phase 9 : l'espace client de relecture.

## Lire d'abord

- `docs/scope-v2.md` : décisions de la v2, en cours. Ne pas élargir sans accord.
- `docs/scope-v1.md` : périmètre livré en v1, il fait foi sur l'existant.
- `docs/architecture.md` : stack, adaptateurs, modèle de données, pipeline.
- `docs/roadmap.md` : phase en cours et critère de fin.
- `docs/runbook.md` : exploitation du pilote, incidents, sauvegardes.

## Règles

- Langue de l'interface et des messages utilisateur : français. Code, identifiants et commits : anglais.
- Toute intégration externe passe par une interface `*Provider` dans `src/server/providers/` avec une implémentation réelle et un mock. Le mode démo doit toujours fonctionner sans réseau.
- Les actions payantes (achat de domaine, commande de serveur) exigent une confirmation explicite en UI, le rôle `admin`, et une entrée `AuditLog`.
- Les secrets ne quittent jamais le serveur : chiffrés en base, jamais dans les réponses API ni dans les logs.
- Les jobs de déploiement sont idempotents et journalisent chaque étape dans `DeploymentLog`.
- Tout ce qui est joignable depuis un site client (`/__forms/*`, bientôt `/__review/*`) est une entrée non fiable : taille bornée, limite de débit, affichage comme du texte et jamais comme du HTML, et jamais exécuté dans l'origine de l'outil.
- Le pilote tourne déjà en production : migrations réversibles, et pas de changement de contrat des routes publiques relayées par Caddy sans mettre à jour les blocs générés dans `src/server/deploy/caddy.ts`.
- La préproduction et la production sont **deux copies distinctes** sur le serveur (`/srv/sites/<slug>--preview/` et `/srv/sites/<slug>/`) : un contenu propre à la préproduction est possible, et ne doit jamais fuiter en production.
- Le runtime de site est une abstraction (`SiteRuntime`) ; `static` reste la seule implémentation, le runtime `docker` est repoussé. Ne pas coupler le wizard ou le dashboard à ce choix.
- Pas de dépendance à VitoDeploy. Les VPS sites ne reçoivent que Caddy, Docker et les fichiers des sites, pilotés par SSH.

## Commandes

- `pnpm dev` : app + worker en local, Postgres via `docker compose up -d db`. `pnpm db:migrate`, `pnpm db:seed`.
- `pnpm test` : Vitest (unitaires + pipelines contre la base `DATABASE_URL_TEST`). `pnpm e2e` : Playwright en mode démo (démarre app et worker).
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
