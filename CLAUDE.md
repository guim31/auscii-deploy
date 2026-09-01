# auscii-deploy

Outil web interne d'AUSCII pour publier des sites vitrine statiques sur des VPS Scaleway, avec domaine Gandi, repo GitHub par site, préproduction puis production. Utilisateurs : gérants non techniciens. UX minimale, système complet derrière.

## Lire d'abord

- `docs/scope-v1.md` : périmètre et décisions. Ne pas élargir sans accord.
- `docs/architecture.md` : stack, adaptateurs, modèle de données, pipeline.
- `docs/roadmap.md` : phase en cours et critère de fin.

## Règles

- Langue de l'interface et des messages utilisateur : français. Code, identifiants et commits : anglais.
- Toute intégration externe passe par une interface `*Provider` dans `src/server/providers/` avec une implémentation réelle et un mock. Le mode démo doit toujours fonctionner sans réseau.
- Les actions payantes (achat de domaine, commande de serveur) exigent une confirmation explicite en UI, le rôle `admin`, et une entrée `AuditLog`.
- Les secrets ne quittent jamais le serveur : chiffrés en base, jamais dans les réponses API ni dans les logs.
- Les jobs de déploiement sont idempotents et journalisent chaque étape dans `DeploymentLog`.
- Le runtime de site est une abstraction (`SiteRuntime`) ; la v1 n'implémente que `static`. Ne pas coupler le wizard ou le dashboard à ce choix.
- Pas de dépendance à VitoDeploy. Les VPS sites ne reçoivent que Caddy, Docker et les fichiers des sites, pilotés par SSH.

## Commandes

- `pnpm dev` : app + worker en local, Postgres via `docker compose up -d db`. `pnpm db:migrate`, `pnpm db:seed`.
- `pnpm test` : Vitest (unitaires + pipelines contre la base `DATABASE_URL_TEST`). `pnpm e2e` : Playwright en mode démo (démarre app et worker).
- `pnpm lint`, `pnpm typecheck`, `pnpm build` : à passer avant tout commit.

## Repères dans le code

- `src/server/providers/` : interfaces (`types.ts`), mocks, coquilles réelles, fabrique `getProviders()`.
- `src/server/jobs/` : pg-boss (`boss.ts`), runner de pipeline avec reprise par étape (`pipeline.ts`), pipelines (`pipelines.ts`), handlers du worker.
- `src/server/capacity.ts` : placement des sites par métriques, pur et testé.
- `src/server/releases/` : extraction sécurisée du zip et analyse statique.
- `src/server/actions/` : server actions appelées par l'UI ; toute action payante y écrit un `AuditLog`.
- `src/components/wizard/` : les 4 étapes ; `deploy-console.tsx` consomme le flux SSE.
- Next 16 : `src/proxy.ts` remplace `middleware.ts`, `params` et `searchParams` sont des promesses.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
