# Runbook (exploitation)

Ce document sera complété au fil des phases. Il fixe dès maintenant les prérequis et la cible d'installation.

## Prérequis côté agence

| Service | À préparer | Utilisé pour |
|---|---|---|
| Scaleway | Projet, clé API (Instances), zone par défaut | Commande des VPS sites |
| Gandi | Compte avec moyen de paiement, clé API (PAT) avec droits domaine et LiveDNS, organisation propriétaire par défaut | Achat de domaines, DNS |
| Domaine agence | `auscii.fr` chez Gandi (ou zone LiveDNS), sous-domaine `preview.auscii.fr` réservé | Préproductions |
| GitHub | Organisation, token avec création de repos privés | Un repo par site |
| Resend | Compte, domaine d'envoi vérifié (`deploy.auscii.fr` ou `auscii.fr`), clé API | Formulaires, notifications |
| Anthropic | Clé API | Rapport d'analyse du site |

## Pilote (hébergement de l'outil)

- Un VPS Scaleway dédié, Debian 12, 2 vCPU / 4 Go recommandés.
- Docker Compose : `app` (Next.js), `worker`, `postgres`. Caddy devant, HTTPS automatique sur `deploy.auscii.fr`.
- Variables : `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `APP_URL`. Les clés des intégrations sont saisies dans l'interface, pas en variables.
- Clé SSH du pilote générée au premier démarrage, conservée dans un volume, clé publique affichée dans Paramètres > Serveurs.
- Sauvegardes : dump Postgres quotidien + volume des releases, vers un bucket Scaleway Object Storage.

## Procédures (à détailler en phase 8)

- Installation à blanc du pilote.
- Ajout manuel d'un serveur existant.
- Rotation d'une clé API ou de la clé SSH.
- Restauration après perte du pilote.
- Incidents : certificat non émis, DNS non propagé, serveur injoignable, rollback d'un site.
