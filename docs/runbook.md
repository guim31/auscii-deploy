# Runbook (exploitation)

Ce document sera complété au fil des phases. Il fixe dès maintenant les prérequis et la cible d'installation.

## Prérequis côté agence

| Service           | À préparer                                                                                                                                      | Utilisé pour                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Scaleway          | Projet, clé API (Instances), zone par défaut                                                                                                    | Commande des VPS sites                                    |
| Gandi             | Compte avec moyen de paiement, clé API (PAT) avec droits domaine et LiveDNS, organisation propriétaire par défaut                               | Achat de domaines, DNS                                    |
| Domaine technique | Un domaine dédié acheté chez Gandi (ex. `auscii.site`). `auscii.com` reste chez OVH avec les emails et n'est jamais modifié                     | Outil (`deploy.…`) et préproductions (`client.preview.…`) |
| GitHub            | Une organisation AUSCII et une GitHub App installée dessus (permissions : contents et administration des dépôts). Aucun compte pour les gérants | Un repo par site                                          |
| Resend            | Compte, domaine d'envoi vérifié (`deploy.auscii.fr` ou `auscii.fr`), clé API                                                                    | Formulaires, notifications                                |
| Anthropic         | Clé API                                                                                                                                         | Rapport d'analyse du site                                 |

## Pilote (hébergement de l'outil)

- Un VPS Scaleway dédié, Debian 12, 2 vCPU / 4 Go recommandés.
- Docker Compose : `app` (Next.js), `worker`, `postgres`. Caddy devant, HTTPS automatique sur `deploy.auscii.fr`.
- Variables : `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `APP_URL`. Les clés des intégrations sont saisies dans l'interface, pas en variables.
- Clé SSH du pilote générée au premier démarrage, conservée dans un volume, clé publique affichée dans Paramètres > Serveurs.
- Sauvegardes : dump Postgres quotidien + volume des releases, vers un bucket Scaleway Object Storage.

## Développement local

```bash
cp .env.example .env          # puis adapter APP_ENCRYPTION_KEY et BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d db        # PostgreSQL 16
pnpm install
pnpm db:migrate                # migrations Prisma
pnpm db:seed                   # premier compte admin (ADMIN_EMAIL / ADMIN_PASSWORD)
pnpm dev                       # app sur http://localhost:3000 + worker
```

Avec `DEMO_MODE=true`, tout le parcours fonctionne sans aucune clé API ni réseau sortant.

Tests : `pnpm test` (Vitest, base `DATABASE_URL_TEST` si définie), `pnpm e2e` (Playwright, démarre l'app et le worker en mode démo).

## Ajouter un serveur existant (phase 2)

1. Paramètres > Intégrations > SSH : **Générer une paire de clés** (ou importer une clé privée OpenSSH existante). La clé publique s'affiche.
2. Créer un VPS Debian 12 (Scaleway DEV1-S conseillé) avec un accès root.
3. Paramètres > Serveurs > **Ajouter un serveur existant** : copier le script affiché (il contient la clé publique), le lancer en root sur le VPS (`bash bootstrap.sh`). Il installe Caddy, Docker, le pare-feu, l'utilisateur `deploy` et pose le marqueur `/var/lib/auscii-ready`.
4. Renseigner le nom, l'IP et valider. L'outil attend le marqueur, mémorise l'empreinte de la clé d'hôte (vérifiée à chaque connexion) et relève les métriques. Le serveur passe à « Prêt ».
5. En cas d'erreur : « Retester ». Après une réinstallation du serveur : « Oublier la clé d'hôte » puis retester.

## DNS manuel (sans Gandi)

Tant que l'intégration Gandi n'est pas configurée, le wizard force « domaine déjà possédé » et le provisioning ignore l'achat et le DNS. La page du site affiche les trois enregistrements `A` à créer chez le registrar : l'apex et `www` du domaine client, et `<slug>.preview.<domaine technique>`. Caddy émet le certificat HTTPS dès que le nom résout vers le serveur. Le relais des formulaires (`/__forms/*`) suppose un pilote joignable publiquement (`deploy.<domaine technique>`), ce qui sera le cas après la phase 8.

## Checklist de validation de la phase 2

1. Clés SSH générées, serveur ajouté et « Prêt », métriques visibles.
2. Site créé avec un domaine que vous contrôlez, enregistrements DNS créés selon la page du site.
3. Zip déposé, préproduction déployée, lien secret ouvert en HTTPS (`https://<slug>.preview.<tech>/__preview/<token>`), page « Accès réservé » sans le cookie.
4. Publication en production, HTTPS valide sur le domaine et `www`, capture d'écran sur le tableau de bord.
5. Nouveau zip, mise à jour, puis retour à la version précédente : le site bascule instantanément.

## Procédures (à détailler en phase 8)

- Installation à blanc du pilote.
- Ajout manuel d'un serveur existant.
- Rotation d'une clé API ou de la clé SSH.
- Restauration après perte du pilote.
- Incidents : certificat non émis, DNS non propagé, serveur injoignable, rollback d'un site.
