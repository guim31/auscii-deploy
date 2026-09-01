# Architecture technique

## Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| App web | Next.js 15 (App Router), TypeScript strict | Full-stack en un projet, très bon support par Claude Code |
| UI | Tailwind + shadcn/ui, textes en français | UX simple, composants accessibles |
| Base de données | PostgreSQL + Prisma | Fiable, migrations, typage |
| Jobs | pg-boss (file de jobs sur Postgres) + process `worker` | Déploiements longs, reprises, pas de Redis à opérer |
| Temps réel | SSE (`/api/deployments/[id]/stream`) lisant `DeploymentLog` | Console de provisioning, simple et robuste |
| Auth | better-auth (email + mot de passe, sessions en base) | Léger, sans SaaS |
| SSH | `ssh2` | Exécution distante, transfert d'archives |
| Git | `simple-git` + Octokit | Repo par site, promotion, tags |
| Captures | Playwright (Chromium) sur le pilote | Vignettes du dashboard |
| Email | Resend (adaptateur, Brevo possible) | Formulaires et notifications |
| IA | SDK Anthropic | Rapport d'analyse du site à l'étape 3 |
| Secrets | AES-256-GCM avec `APP_ENCRYPTION_KEY` | Clés API chiffrées en base |
| Tests | Vitest (unitaires, contrats), Playwright (e2e en mode démo) | |
| Exploitation | Docker Compose (app, worker, postgres) derrière Caddy | Un seul VPS pilote |

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

| Interface | Méthodes | Implémentations |
|---|---|---|
| `DomainProvider` | `check(fqdn)`, `register(fqdn, contact)`, `getOrderStatus(id)`, `setRecords(fqdn, records[])` | `GandiProvider`, `MockDomainProvider` |
| `CloudProvider` | `listOffers()`, `createServer(spec, cloudInit)`, `getServer(id)`, `deleteServer(id)` | `ScalewayProvider`, `MockCloudProvider` |
| `GitProvider` | `createRepo(slug)`, `pushRelease(repo, files, branch)`, `promote(repo)`, `tag(repo, name)` | `GitHubProvider`, `MockGitProvider` |
| `MailProvider` | `send(message)` | `ResendProvider`, `MockMailProvider` |
| `AiProvider` | `analyzeSite(files)` | `AnthropicProvider`, `MockAiProvider` |
| `ServerAgent` | `exec(cmd)`, `uploadArchive(tar, dest)`, `switchRelease(slug, ts)`, `writeCaddySite(slug, config)`, `reloadCaddy()` | `SshServerAgent`, `MockServerAgent` |

Les mocks reproduisent les délais et les états intermédiaires (commande de domaine « en attente », serveur « en cours de démarrage ») pour que la démo soit fidèle au réel.

## Runtime de site (préparation v2)

Interface `SiteRuntime` : `prepare(server)`, `deploy(release)`, `caddyConfig(site)`.

- v1 : `StaticRuntime`. Archive tar.gz envoyée par SSH, extraite dans `releases/<ts>`, bascule du lien `current`, bloc Caddy `file_server`.
- v2 : `DockerRuntime`. Build ou pull d'une image, un conteneur par site, bloc Caddy `reverse_proxy`. Docker est installé dès la v1 par cloud-init pour éviter tout re-provisioning.

Le champ `Site.runtime` porte ce choix. Le reste de l'outil (wizard, dashboard, DNS, domaine, repo) est indépendant du runtime.

## Modèle de données (Prisma)

- `User` (email, hash, role `admin|manager`), `Session`
- `Server` : provider, providerId, name, ip, sshUser, status `ordering|bootstrapping|ready|error|retired`, maxSites, offer, zone, isDemo
- `Site` : slug, clientName, domain, previewHost, serverId, runtime `static`, status `draft|provisioning|preview|live|error`, formsEmail, gitRepo, previewToken, isDemo
- `Domain` : siteId, fqdn, registrar, orderId, orderStatus, price, expiresAt, dnsConfigured
- `Release` : siteId, version, commitSha, gitTag, archiveHash, analysisReport (JSON), createdBy
- `Deployment` : siteId, releaseId, environment `staging|production`, status `queued|running|succeeded|failed`, startedAt, finishedAt, rollbackOfId, triggeredBy
- `DeploymentLog` : deploymentId, ts, level, step, message
- `FormSubmission` : siteId, payload (JSON), fromIp, emailedAt
- `Integration` : provider, encryptedCredentials, updatedAt, lastTestAt
- `SslCheck` : siteId, issuer, expiresAt, checkedAt, ok
- `AuditLog` : userId, action, target, amount, createdAt (achats, commandes)

## Pipeline de déploiement

Jobs pg-boss exécutés par le worker. Chaque job est idempotent, journalise dans `DeploymentLog` et peut être relancé depuis la console.

1. `server.ensureCapacity` : choisit un serveur `ready` avec de la place ; sinon `server.order` (Scaleway + cloud-init) puis `server.bootstrap` (attente SSH, vérification Caddy, marquage `ready`).
2. `domain.register` (après confirmation explicite en UI) puis `domain.configureDns` : `A` apex, `A www`, `A <slug>.preview` vers le serveur.
3. `git.createRepo` puis `git.importRelease` : contenu du zip poussé sur `staging`.
4. `site.deploy(staging)` : archive envoyée par SSH, extraction dans `releases/<ts>`, bascule de `current`, écriture du bloc Caddy preview, reload.
5. `site.promote` : fusion `staging` → `production`, tag `prod-<AAAAMMJJ-HHMM>`, puis `site.deploy(production)` sur le domaine, `ssl.check`, `screenshot.capture`.
6. `site.rollback` : bascule de `current` vers la release précédente, instantané.
7. Récurrents : `ssl.checkAll` (quotidien), `server.health` (horaire).

## Provisioning des VPS sites (cloud-init)

Image Debian 12. Le script cloud-init :
- crée l'utilisateur `deploy` avec la clé publique du pilote, sans mot de passe,
- installe Caddy (dépôt officiel) et Docker,
- écrit `/etc/caddy/Caddyfile` avec `import /etc/caddy/sites/*.caddy`,
- donne à `deploy` le droit d'écrire dans `/etc/caddy/sites` et `/srv/sites`, et un sudo limité à `systemctl reload caddy`,
- configure ufw (22, 80, 443), fail2ban, unattended-upgrades,
- désactive la connexion SSH par mot de passe.

## Caddy sur les VPS sites

Bloc production, généré par l'outil :

```
client.fr, www.client.fr {
  root * /srv/sites/<slug>/current
  encode gzip
  file_server
  handle /__forms/* {
    reverse_proxy https://deploy.auscii.fr {
      header_up X-Site <slug>
      header_up Host deploy.auscii.fr
    }
  }
}
```

Bloc preview : identique sur `<slug>.preview.auscii.fr`, avec une porte d'accès par lien secret :
- `/__preview/<token>` pose un cookie `auscii_preview=<token>` et redirige vers `/`,
- sans cookie valide (matcher sur l'en-tête `Cookie`), Caddy sert une page « Accès réservé ».

HTTPS automatique par hôte (défi HTTP-01). Un enregistrement `A <slug>.preview.auscii.fr` est créé par site vers le bon serveur via LiveDNS ; pas de wildcard, ce qui fonctionne avec plusieurs serveurs.

## Formulaires de contact (centralisés sur le pilote)

- Le site poste sur `/__forms/contact`, même origine, donc aucun CORS. Caddy relaie vers le pilote avec l'en-tête `X-Site`.
- Le pilote valide (honeypot, limite de débit par IP, taille), enregistre `FormSubmission`, envoie l'email à `Site.formsEmail`, puis redirige vers `/merci.html` si présent, sinon répond en JSON.
- Aucun service à opérer sur les VPS sites.

## Sécurité

- Clés API chiffrées en base (AES-256-GCM), jamais renvoyées au navigateur.
- Clé SSH du pilote générée à l'installation, clé publique injectée par cloud-init. Utilisateur `deploy` sans sudo hormis le reload de Caddy.
- Achat de domaine et commande de serveur : confirmation explicite, rôle `admin`, `AuditLog`.
- Sessions HTTP-only, protection CSRF de better-auth, upload limité à 50 Mo, extraction du zip sécurisée (refus de `../`, des liens symboliques, des fichiers exécutables).
- Contenu du preview servi par le pilote à l'étape 3 sous un sous-domaine dédié, avec en-têtes `Content-Security-Policy` restrictifs.

## Structure du repo (cible)

```
auscii-deploy/
  CLAUDE.md
  docs/
  src/
    app/                  (auth)/login, (app)/dashboard, sites/[id], deploy (wizard), settings/*
    server/
      db/                 client Prisma
      auth/
      providers/          domain/ cloud/ git/ mail/ ai/ + mocks
      deploy/             agent SSH, templates Caddy, runtimes (static)
      jobs/               définitions pg-boss, machine à états
      forms/
      crypto/
    worker/index.ts
    components/
  prisma/schema.prisma
  infra/
    cloud-init.yaml
    caddy/                templates de blocs
    docker-compose.yml    pilote (app, worker, postgres)
    Caddyfile.pilot
  e2e/
```
