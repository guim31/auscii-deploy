# Périmètre fonctionnel v1

## Décisions de cadrage

| Sujet                  | Décision                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réalité                | Vraies intégrations dès la v1, **mode démo débrayable** (mocks)                                                                                                                    |
| Type de sites          | Statique (HTML/CSS/JS, ou site buildé). Architecture prête pour Docker en v2                                                                                                       |
| Source du site         | Upload d'un `.zip` produit localement avec Claude Code                                                                                                                             |
| Stack de l'outil       | Next.js + TypeScript                                                                                                                                                               |
| Orchestration VPS      | SSH direct + Caddy (HTTPS automatique). Pas de VitoDeploy                                                                                                                          |
| Domaines               | Gandi : vérification, **achat avec confirmation explicite**, LiveDNS                                                                                                               |
| VPS                    | Scaleway, offre DEV1-S par défaut. Commandés automatiquement par l'outil quand la capacité (mesurée) est atteinte                                                                  |
| Capacité               | Par métriques relevées en SSH (CPU, mémoire, disque, nombre de sites), seuils configurables, plafond de sécurité. Pas de limite fixe                                               |
| Versionnement          | Un repo GitHub privé par site, branches `staging` / `production`. L'outil s'authentifie comme GitHub App sur l'organisation AUSCII ; les gérants n'ont pas besoin de compte GitHub |
| Domaine technique      | `auscii.com` (OVH, avec les emails) n'est jamais touché. Un domaine technique dédié chez Gandi porte l'outil (`deploy.…`) et les préproductions (`client.preview.…`)               |
| Formulaires de contact | Service intégré à l'outil, email via un fournisseur transactionnel                                                                                                                 |
| Préproduction          | `<client>.preview.auscii.fr`, protégée par lien secret                                                                                                                             |
| Hébergement de l'outil | VPS pilote dédié, Docker, connexion email + mot de passe                                                                                                                           |
| Étape 3 du wizard      | Upload + vérification automatique + rapport Claude API, prévisualisation iFrame                                                                                                    |

## Dashboard

- Liste des sites en production, une carte par site :
  - capture d'écran (rafraîchie à chaque publication),
  - URL cliquable,
  - serveur d'hébergement,
  - état HTTPS : émetteur et date d'expiration, vérifiés quotidiennement, alerte à moins de 14 jours,
  - date et auteur de la dernière publication.
- Actions par site :
  - **Voir** : iFrame modale,
  - **Préprod** : ouvre `client.preview.auscii.fr` avec le lien secret,
  - **Mettre à jour** : dépôt d'un nouveau `.zip`, passage par la préprod, publication,
  - **Revenir à la version précédente** : bascule instantanée vers la release précédente,
  - **Historique** : liste des déploiements avec logs,
  - **Messages** : soumissions reçues via les formulaires.
- Bouton principal `+ Déployer un nouveau site`.
- Bandeau d'état des serveurs : nombre de sites par serveur, capacité.
- Interrupteur **Mode démo** dans l'en-tête (voir plus bas).

## Wizard (4 étapes)

### Étape 1 : Domaine

- Nom du client (génère un identifiant `slug` utilisé partout : repo, dossier serveur, sous-domaine preview).
- Domaine souhaité : vérification de disponibilité Gandi en direct, prix affiché, suggestions d'extensions (`.fr`, `.com`).
- Cas « ce domaine est déjà à nous chez Gandi » : pas d'achat, DNS seulement.
- Email destinataire des formulaires de contact.
- Serveur choisi automatiquement : carte d'information « Serveur : vps-02 (12 sites) » ou « Un nouveau serveur sera commandé (≈ X €/mois) », avec confirmation par un admin dans ce second cas.

### Règle de capacité

Un job horaire relève sur chaque serveur la charge CPU (`load15` par vCPU), la mémoire, le disque utilisé et libre, et le nombre de sites. Un serveur accueille un nouveau site si aucune dimension ne dépasse son seuil (défaut : disque 80 %, mémoire 80 %, charge 0,8 par vCPU), si l'espace libre couvre 3 × la taille de l'archive + 2 Go, et si le plafond de sécurité (100 sites) n'est pas atteint. Les serveurs se remplissent l'un après l'autre : le plus rempli qui a encore de la place est choisi. Un serveur qui dépasse 70 % d'un seuil est signalé comme « charge élevée ».

### Étape 2 : Provisioning

Console en temps réel, vrais logs, étapes reprises en cas d'erreur :

1. Commande et préparation d'un serveur si aucun n'a de place (**confirmation du coût mensuel**).
2. Achat du domaine (**écran de confirmation du prix, obligatoire**), puis attente de l'enregistrement.
3. Enregistrements DNS : `A` apex et `A www` vers le serveur, `A <slug>.preview.auscii.fr` vers le serveur.
4. Création du repo GitHub privé `auscii/<slug>`.
5. Préparation du vhost sur le serveur (dossiers, bloc Caddy preview).

### Étape 3 : Site

- Dépôt du `.zip` (glisser-déposer, 50 Mo max).
- Vérification automatique, synchrone :
  - présence d'un `index.html` (à la racine ou dans un unique dossier racine),
  - taille et nombre de fichiers,
  - liens internes cassés,
  - formulaires détectés et vérification de leur `action` (doit pointer vers `/__forms/contact`), avec correction proposée,
  - fichiers suspects (exécutables, liens symboliques, chemins `../`) refusés.
- Prévisualisation immédiate dans une iFrame servie par l'outil.
- Rapport court Claude API (SEO de base, accessibilité, cohérence du contenu), asynchrone, jamais bloquant.

### Étape 4 : Mise en ligne

1. **Déployer en préproduction** : release envoyée sur le serveur, URL preview et lien secret à partager au client, bouton « Copier le lien ».
2. **Publier en production** : fusion `staging` → `production`, tag, déploiement sur le domaine, vérification HTTPS, capture d'écran, ajout au dashboard.

## Paramètres

- **Intégrations** : Gandi, Scaleway, GitHub (organisation), Resend, Anthropic. Clés stockées chiffrées, jamais renvoyées au navigateur, bouton « Tester la connexion ».
- **Serveurs** : liste, jauges CPU / mémoire / disque, bouton « Commander un serveur » (admin, avec prix), relevé des métriques à la demande, retrait d'un serveur vide.
- **Agence** : domaine technique et sous-domaine de preview, offre et zone Scaleway par défaut, contact Gandi (obligatoire pour l'achat), seuils de capacité.
- **Utilisateurs** : 2 à 5 comptes, rôles `admin` (paramètres, achats) et `gérant` (déploiements).

## Mode démo

- Interrupteur dans l'en-tête, réservé aux admins.
- Tous les adaptateurs externes basculent sur des mocks avec délais réalistes ; aucun appel réseau sortant.
- Données de démo seedées (3 sites, 2 serveurs), marquées `isDemo` et invisibles hors démo.
- Bouton « Réinitialiser la démo ».

## Actions payantes

L'achat d'un domaine et la commande d'un serveur sont les deux seules actions qui engagent de l'argent. Elles passent toujours par un écran de confirmation explicite avec le prix, sont réservées au rôle `admin`, et sont journalisées (qui, quand, quoi, montant).

## Hors périmètre v1

- Sites dynamiques (Node, PHP, WordPress) : prévus via un runtime `docker` en v2, sans refonte (voir architecture).
- Génération du site depuis un brief dans l'outil.
- Multi-registrar, multi-cloud.
- Facturation et espace client.
- Gestion des emails du client (MX).
