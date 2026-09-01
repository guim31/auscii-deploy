# Concept

## Vision

**auscii-deploy** est un outil web permettant à l'agence de communication AUSCII de déployer automatiquement sur des VPS (Scaleway) les sites web de ses clients, d'abord en préproduction (staging) puis en production. Les sites sont créés par les gérants de l'agence, sur leur ordinateur, avec Claude Code, et fournis à l'outil sous forme de `.zip`.

Le but : des gérants **néophytes** accèdent à l'outil quand un site est prêt et, en quelques clics, le publient sur le nom de domaine choisi. L'interface est volontairement minimale et cache un système complet : achat de domaine, DNS, serveurs, HTTPS, versionnement, formulaires de contact.

## Parcours utilisateur

L'application se divise en deux zones.

### 1. Le dashboard

- Écran d'accueil par défaut.
- Liste les sites en production : vignette, URL, serveur d'hébergement, certificat HTTPS (Let's Encrypt), date de dernière publication.
- Actions de supervision : voir le site dans une iFrame modale, ouvrir la préproduction, mettre à jour, revenir en arrière, consulter l'historique et les messages reçus.
- Bouton principal : `+ Déployer un nouveau site`, qui lance le wizard.

### 2. Le wizard de déploiement (4 étapes)

1. **Domaine** : saisie du domaine souhaité, vérification de disponibilité via l'API Gandi, prix affiché. Le serveur VPS cible est choisi automatiquement par l'outil (ou commandé si la capacité est atteinte).
2. **Provisioning** : console système en temps réel montrant l'enregistrement du domaine (Gandi), la configuration DNS (LiveDNS), la création du repo privé GitHub et la préparation du serveur.
3. **Site** : dépôt du `.zip` produit avec Claude Code, vérification automatique du contenu, prévisualisation immédiate dans une iFrame, rapport court généré par Claude (SEO, accessibilité).
4. **Mise en ligne** :
   1. _Préproduction_ : déploiement sur `client.preview.auscii.fr` avec un lien secret, pour validation interne et relecture client.
   2. _Production_ : clic final qui fusionne `staging` vers `production` et publie le site sur son domaine. Le site apparaît alors sur le dashboard.

## Historique

Un mockup cliquable a d'abord été réalisé pour les gérants (avec API Gandi simulée, VitoDeploy simulé, faux logs). Ce dépôt est le projet réel. Le parcours du mockup est conservé et devient un **mode démo** débrayable, utile pour les présentations et les tests.
