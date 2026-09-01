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

## Commandes (à partir de la phase 1)

- `pnpm dev` : app + worker en local, Postgres via `docker compose up db`.
- `pnpm test` : Vitest. `pnpm e2e` : Playwright en mode démo.
- `pnpm lint`, `pnpm typecheck` : à passer avant tout commit.
