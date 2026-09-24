# Architecture technique

## Stack

| Couche          | Choix                                                                                  | Pourquoi                                                  |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| App web         | Next.js 16 (App Router, Server Actions), TypeScript strict                             | Full-stack en un projet, très bon support par Claude Code |
| UI              | Tailwind v4 + composants Radix (style shadcn, écrits dans le repo), textes en français | UX simple, composants accessibles                         |
| Base de données | PostgreSQL 16 + Prisma 6                                                               | Fiable, migrations, typage                                |
| Jobs            | pg-boss (file de jobs sur Postgres) + process `worker`                                 | Déploiements longs, reprises, pas de Redis à opérer       |
| Temps réel      | SSE (`/api/deployments/[id]/stream`) lisant `DeploymentLog`                            | Console de provisioning, simple et robuste                |
| Auth            | better-auth (email + mot de passe, sessions en base)                                   | Léger, sans SaaS                                          |
| SSH             | `ssh2`                                                                                 | Exécution distante, transfert d'archives                  |
| Git             | `simple-git` + Octokit                                                                 | Repo par site, promotion, tags                            |
| Captures        | Playwright (Chromium) sur le pilote                                                    | Vignettes du dashboard                                    |
| Email           | Resend (adaptateur, Brevo possible)                                                    | Formulaires et notifications                              |
| IA              | SDK Anthropic                                                                          | Rapport d'analyse du site à l'étape 3                     |
| Secrets         | AES-256-GCM avec `APP_ENCRYPTION_KEY`                                                  | Clés API chiffrées en base                                |
| Tests           | Vitest (unitaires, contrats), Playwright (e2e en mode démo)                            |                                                           |
| Exploitation    | Docker Compose (app, worker, postgres) derrière Caddy                                  | Un seul VPS pilote                                        |

## Vue d'ensemble

```
Gérant ──HTTPS──> [VPS pilote : Caddy → app Next.js + worker + Postgres]
                        │ API                         │ SSH (clé du pilote)
                        ▼                             ▼
          Gandi / Scaleway / GitHub /        [VPS sites N : Caddy + Docker]
          Resend / Anthropic                 /srv/sites/<slug>/releases/<ts>/
                                             /srv/sites/<slug>/current -> releases/<ts>
                                             /etc/caddy/sites/<slug>.caddy
```

Le **pilote** héberge l'outil. Les **VPS sites** n'hébergent que Caddy, Docker (inutilisé en v1, prêt pour la v2) et les fichiers des sites. Le pilote pilote tout en SSH ; aucun agent à installer sur les VPS sites.

## Adaptateurs « provider »

Chaque intégration externe est une interface TypeScript avec deux implémentations : réelle et mock. Le mode démo bascule tout sur les mocks. C'est aussi ce qui permet de changer de registrar ou de cloud plus tard.

| Interface        | Méthodes                                                                                                            | Implémentations                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `DomainProvider` | `check(fqdn)`, `register(fqdn, contact)`, `getOrderStatus(id)`, `setRecords(fqdn, records[])`                       | `GandiProvider`, `MockDomainProvider`   |
| `CloudProvider`  | `listOffers()`, `createServer(spec, cloudInit)`, `getServer(id)`, `deleteServer(id)`                                | `ScalewayProvider`, `MockCloudProvider` |
| `GitProvider`    | `createRepo(slug)`, `pushRelease(repo, files, branch)`, `promote(repo)`, `tag(repo, name)`                          | `GitHubProvider`, `MockGitProvider`     |
| `MailProvider`   | `send(message)` ; `ResendProvider` gère aussi le domaine d'envoi (`ensureSendingDomain`, `verifyDomain`)            | `ResendProvider`, `MockMailProvider`    |
| `AiProvider`     | `analyzeSite(input)` : pages, constats automatiques → rapport structuré ; `whoAmI()`                                | `AnthropicProvider`, `MockAiProvider`   |
| `ServerAgent`    | `exec(cmd)`, `uploadArchive(tar, dest)`, `switchRelease(slug, ts)`, `writeCaddySite(slug, config)`, `reloadCaddy()` | `SshServerAgent`, `MockServerAgent`     |

Les mocks reproduisent les délais et les états intermédiaires (commande de domaine « en attente », serveur « en cours de démarrage ») pour que la démo soit fidèle au réel.

## Runtime de site (préparation v2)

Interface `SiteRuntime` : `prepare(server)`, `deploy(release)`, `caddyConfig(site)`.

- v1 : `StaticRuntime`. Archive tar.gz envoyée par SSH, extraite dans `releases/<ts>`, bascule du lien `current`, bloc Caddy `file_server`.
- v2 : `DockerRuntime`. Build ou pull d'une image, un conteneur par site, bloc Caddy `reverse_proxy`. Docker est installé dès la v1 par cloud-init pour éviter tout re-provisioning.

Le champ `Site.runtime` porte ce choix. Le reste de l'outil (wizard, dashboard, DNS, domaine, repo) est indépendant du runtime.

## Modèle de données (Prisma)

- `User` (email, hash, role `admin|manager`), `Session`
- `Server` : provider, providerId, name, ip, sshUser, status `ordering|bootstrapping|ready|error|retired`, offer, zone, vcpus, monthlyPrice, metrics (JSON : load15, ramUsedPct, diskUsedPct, diskFreeBytes, sitesCount, collectedAt), isDemo
- `AppSetting` : clé/valeur JSON (demoMode, techDomain, previewSubdomain, defaultOffer, defaultZone, gandiContact, capacity)
- `Site` : slug, clientName, domain, previewHost, serverId, runtime `static`, status `draft|provisioning|ready|preview|live|error`, formsEmail, gitRepo, previewToken, stagingReleaseId, liveReleaseId, screenshotPath, isDemo
- `Domain` : siteId, fqdn, registrar, orderId, orderStatus, price, expiresAt, dnsConfigured
- `Release` : siteId, version, commitSha, gitTag, archiveHash, analysisReport (JSON), createdBy
- `Deployment` : siteId, releaseId, kind `provision|deploy|promote|rollback`, environment `staging|production`, status `queued|running|succeeded|failed`, steps (JSON : état de chaque étape, base de la reprise), startedAt, finishedAt, rollbackOfId, triggeredBy
- `DeploymentLog` : deploymentId, ts, level, step, message
- `FormSubmission` : siteId, payload (JSON), fromIp, env (`production|preview`), emailedAt (nul tant que l'email n'est pas parti)
- `Alert` : kind (`domain_expiry|tls_failure|deployment_failed`), key, day, subject, body, sentAt, error ; unique par (kind, key, day)
- `Integration` : provider, encryptedCredentials, updatedAt, lastTestAt
- `SslCheck` : siteId, issuer, expiresAt, checkedAt, ok
- `AuditLog` : userId, action, target, amount, createdAt (achats, commandes)

## Pipeline de déploiement

Un job pg-boss exécute un pipeline entier (`site.provision`, `site.deploy`, `site.promote`, `site.rollback`). Le pipeline enregistre l'état de chaque étape dans `Deployment.steps` : une relance reprend à l'étape échouée, les étapes terminées ne sont jamais rejouées. Chaque étape journalise dans `DeploymentLog` (secrets masqués), diffusé en temps réel par SSE.

Garanties :

- le déploiement est pris atomiquement (`queued` → `running`) : un job en double ou relivré ne fait rien ; les files de pipeline ont `retryLimit: 0` et un battement de cœur, et un déploiement interrompu est marqué en échec au démarrage du worker ;
- un seul déploiement en attente ou en cours par site (verrou consultatif PostgreSQL à la création) ;
- les confirmations des actions payantes sont stockées sur le `Deployment` ; le serveur commandé est rattaché au site avant l'appel au fournisseur et reçoit son identifiant dès que l'instance existe ; l'achat de domaine passe par un état `ordering`, et une reprise cherche le domaine dans le compte avant tout nouvel achat ;
- les providers sont choisis d'après `site.isDemo` ou `server.isDemo`, jamais d'après le mode affiché ;
- un échec ne sort jamais un site de la production : seul un provisioning échoué met le site en `error`.

1. `server` : choisit, par métriques, le serveur le plus rempli qui a encore de la place ; sinon commande un serveur (Scaleway + cloud-init) après confirmation d'un admin, attend l'IP, SSH et Caddy, puis le marque `ready`.
2. `domain.register` (après confirmation explicite en UI) puis `domain.configureDns` : `A` apex, `A www`, `A <slug>.preview` vers le serveur.
3. `git.createRepo` puis `git.importRelease` : contenu du zip poussé sur `staging`.
4. `site.deploy(staging)` : archive envoyée par SSH, extraction dans `releases/<ts>`, bascule de `current`, écriture du bloc Caddy preview, reload.
5. `site.promote` : fusion `staging` → `production`, tag `prod-<AAAAMMJJ-HHMM>`, puis `site.deploy(production)` sur le domaine, `ssl.check`, `screenshot.capture`.
6. `site.rollback` : bascule de `current` vers la release choisie, instantanée tant qu'elle est encore sur le serveur (les trois dernières versions publiées sont conservées) ; sinon elle est renvoyée.
7. Récurrents : `server.health` (horaire, relève les métriques de capacité), `ssl.check` (quotidien), `release.aiReport` (à chaque dépôt de zip, sans bloquer le wizard).

## Provisioning des VPS sites (cloud-init)

Image Debian 12. Le script cloud-init :

- crée l'utilisateur `deploy` avec la clé publique du pilote, sans mot de passe,
- installe Caddy (dépôt officiel) et Docker,
- écrit `/etc/caddy/Caddyfile` avec `import /etc/caddy/sites/*.caddy`,
- donne à `deploy` le droit d'écrire dans `/etc/caddy/sites` et `/srv/sites`, et un sudo limité à `systemctl reload caddy`,
- configure ufw (22, 80, 443), fail2ban, unattended-upgrades,
- désactive la connexion SSH par mot de passe.

## Caddy sur les VPS sites

Bloc production, généré par l'outil (`src/server/deploy/caddy.ts`, exemple pour le slug `dupont`) :

```
client.fr, www.client.fr {
	root * /srv/sites/dupont/current
	encode zstd gzip
	header {
		-Server
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	@dotfiles {
		path */.*
		not path /.well-known/*
	}
	handle /__forms/* {
		request_body {
			max_size 64KB
		}
		request_header -X-Auscii-*
		request_header -X-Site
		request_header -X-Site-Env
		request_header -Cookie
		request_header -Authorization
		rewrite * /api/forms
		reverse_proxy https://deploy.auscii.site {
			header_up Host deploy.auscii.site
			header_up X-Site dupont
			header_up X-Auscii-Relay <secret propre au site>
			header_up X-Auscii-Client-Ip {remote_host}
			header_up X-Auscii-Site-Host {host}
		}
	}
	handle {
		error @dotfiles 404
		try_files {path} {path}/index.html {path}.html
		file_server
	}
	handle_errors { … page 404.html du site … }
}
```

Le bloc est écrit sous verrou dans un fichier temporaire, validé avec `caddy validate`, et l'ancien bloc est restauré si la validation échoue.

Bloc preview : identique sur `<slug>.preview.auscii.fr`, avec une porte d'accès par lien secret :

- `/__preview/<token>` pose un cookie `auscii_preview=<token>` et redirige vers `/` (`redir * / 302`),
- sans cookie valide (matcher sur l'en-tête `Cookie`), Caddy sert une page « Accès réservé ».

- le relais des formulaires envoie en plus `X-Site-Env: preview`.

HTTPS automatique par hôte (défi HTTP-01). Un enregistrement `A <slug>.preview.<domaine des préproductions>` est créé par site vers le bon serveur via LiveDNS ; pas de wildcard, ce qui fonctionne avec plusieurs serveurs.

## Formulaires de contact (centralisés sur le pilote)

- Le site poste sur `/__forms/contact`, même origine, donc aucun CORS. Le Caddy du site limite le corps à 64 Ko, retire les en-têtes envoyés par le visiteur, réécrit le chemin en `/api/forms` et relaie vers le pilote avec `X-Site` (slug du site), `X-Auscii-Relay` (secret propre au site, dérivé de `APP_ENCRYPTION_KEY`), `X-Auscii-Client-Ip` et, en préproduction seulement, `X-Site-Env: preview`.
- Le pilote refuse toute requête sans secret valide (403), borne le corps (64 Ko, 30 champs), limite le débit par visiteur et par site, ignore les envois du honeypot `_gotcha`, enregistre `FormSubmission`, met l'email en file (`mail.send`, reprise avec délai croissant, clé d'idempotence) et répond : redirection 303 relative vers le champ `_redirect` s'il est fourni, sinon JSON. Le worker envoie l'email à `Site.formsEmail` et marque `emailedAt` ; la page du site signale les messages non transmis et permet de les renvoyer.
- Alertes à l'agence par la même file : `raiseAlert()` (`jobs/alerts.ts`) dédoublonne par sujet et par jour, puis `mail.send` envoie à `Settings.alertEmail`.
- Domaine d'envoi : `no-reply@<domaine technique>` par défaut ; l'outil déclare le domaine chez Resend et écrit les enregistrements SPF/DKIM dans LiveDNS.
- Aucun service à opérer sur les VPS sites.

## Mode démo

`DEMO_MODE=true` (ou l'interrupteur de l'en-tête, réservé aux admins) bascule la fabrique `getProviders()` sur les mocks. Les mocks reproduisent les délais et les états intermédiaires (commande de domaine en attente, serveur qui démarre, métriques qui évoluent). Les données de démo sont marquées `isDemo` et invisibles hors démo ; « Réinitialiser la démo » les recrée, y compris les fichiers des releases et les captures.

## Hébergement du pilote

Pile Docker Compose sur un VPS dédié (`infra/pilot/`) : Caddy en frontal (HTTPS automatique, en-têtes de sécurité, limite de taille des envois), `app` (image Next.js autonome), `worker` (mêmes sources, plus `git` et Chromium), PostgreSQL, un service de migrations qui s'exécute avant l'application, et un service de sauvegarde nocturne. Les images sont construites par la CI et publiées sur GHCR ; le pilote exécute un tag versionné, ce qui rend le retour arrière immédiat.

## Sécurité

- Clés API chiffrées en base (AES-256-GCM), jamais renvoyées au navigateur.
- Clé SSH du pilote générée depuis l'interface (Paramètres > Intégrations), clé publique injectée par cloud-init. Utilisateur `deploy` sans sudo hormis le reload de Caddy, et hors du groupe `docker`. Clé d'hôte acceptée au premier contact puis épinglée, avec une entrée `AuditLog`.
- Achat de domaine et commande de serveur : confirmation explicite, rôle `admin`, `AuditLog`.
- Sessions HTTP-only, protection CSRF de better-auth, upload limité à 50 Mo, extraction du zip sécurisée (refus de `../`, des liens symboliques, des fichiers exécutables).
- Aperçu de l'étape 3 servi par le pilote sous `/apercu/<jeton signé>/` sur une origine dédiée (`PREVIEW_ORIGIN`, domaine distinct de l'outil), sans cookie de session, avec une CSP `sandbox` restrictive.
- Préproductions des clients sur un domaine enregistrable distinct de celui de l'outil (réglage « domaine des préproductions »).
- Relais des formulaires authentifié par un secret par site ; fichiers cachés (`.env`, `.git`…) écartés des archives et jamais servis par Caddy.
- Mots de passe de 12 caractères minimum, sessions de 7 jours, pas d'inscription publique, pas de plugin `admin` de better-auth (ses routes contourneraient les garde-fous et le journal).

## Structure du repo

```
auscii-deploy/
  CLAUDE.md
  docs/
  src/
    app/                  (auth)/login, (app)/ tableau de bord, sites/[siteId], deploy/ (wizard), settings/*
                          api/ : auth, forms, health, sites/[siteId]/upload, deployments/[id]/stream, screenshots
                          apercu/ : aperçu signé des versions (étape 3)
    proxy.ts              redirection vers /login (Next 16)
    server/
      db.ts, env.ts, auth.ts, session.ts, crypto.ts, settings.ts, mode.ts, forms.ts, audit.ts
      providers/          domain/ cloud/ git/ mail/ ai/ agent/ screenshot/, mocks, http-utils.ts
      deploy/             blocs Caddy, runtime static, bootstrap, DNS, TLS, clés SSH, relais
      jobs/               pg-boss, pipeline, pipelines, steps/, mail, alerts, maintenance
      releases/           extraction, analyse, correction des formulaires, URL d'aperçu
      actions/            server actions
    worker/index.ts
    components/
  prisma/schema.prisma
  infra/
    bootstrap-server.sh   installation d'un serveur de sites (identique au cloud-init)
    pilot/                docker-compose.yml, Caddyfile.pilot, install, update, backup, restore
  e2e/
```
