# Création des comptes et espaces chez les fournisseurs

Guide pas à pas pour ouvrir, au nom d'AUSCII, les comptes dont l'outil a besoin :
Gandi, Scaleway, GitHub et Resend. Le compte Anthropic existe déjà (les gérants
utilisent Claude Code), il suffit d'y créer une clé API, voir la fin du guide.

Il complète `runbook.md`, qui décrit ensuite la saisie des clés dans l'outil et
l'installation du pilote.

> Les libellés de menus sont ceux des consoles telles que connues à la rédaction.
> Les fournisseurs les déplacent régulièrement : si un libellé ne correspond pas,
> chercher la notion (jeton, application, politique, membre) plutôt que le mot exact.

## Principes

- **AUSCII est propriétaire de tout.** Chaque compte s'ouvre avec une adresse email
  de l'agence et le moyen de paiement de l'agence. Le contact technique est **invité**
  dessus avec son propre identifiant : il peut tout faire, mais il ne possède rien.
- **L'outil n'utilise jamais le compte d'une personne.** Il s'authentifie avec des
  identifiants de service (application IAM Scaleway, GitHub App, clés API). Ils
  survivent au départ de n'importe qui. Seule exception : le jeton Gandi, lié à
  l'utilisateur qui le crée, d'où la boîte technique ci-dessous.
- **Une séance, à deux.** Le gérant crée le compte, enregistre la carte et active la
  double authentification sur son téléphone. Le contact technique prend ensuite le
  clavier pour la partie « identifiants pour l'outil ». Compter une demi-journée.

### Rôles dans ce guide

| Qui                      | Fait                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| **Le gérant**            | Ouvre les comptes, saisit les informations de l'entreprise, la carte, la double auth |
| **Le contact technique** | Se fait inviter, crée les identifiants de service, les saisit dans l'outil, teste    |

### Avant de commencer

1. **Créer une boîte technique** sur le domaine de l'agence, par exemple
   `tech@auscii.com`, dans l'espace OVH (Web Cloud > Emails > le domaine > Créer un
   compte). Elle reçoit les emails des quatre fournisseurs. Ne pas utiliser la boîte
   personnelle d'un gérant : les comptes doivent rester à l'agence.
2. **Choisir un gestionnaire de mots de passe** partagé (Bitwarden, Proton Pass ou
   celui déjà en usage). Chaque mot de passe et chaque code de secours y va, jamais
   dans un email ni un fichier.
3. **Un téléphone pour la double authentification** : celui du gérant, avec une
   application d'authentification (Google Authenticator, Authy, ou celle du
   gestionnaire de mots de passe). Les codes de secours de chaque service sont notés
   dans le gestionnaire de mots de passe.
4. **Avoir sous la main** : raison sociale, SIRET, numéro de TVA, adresse du siège,
   téléphone, carte bancaire de l'entreprise.
5. **Choisir le domaine technique.** Un domaine dédié à l'outil, acheté chez Gandi,
   par exemple `auscii.site`. Il porte l'outil (`deploy.auscii.site`) et les
   préproductions (`<client>.preview.auscii.site`). `auscii.com` reste chez OVH avec
   les emails et n'est jamais touché.

### Ce qu'on doit avoir à la fin

| Service   | Pour l'outil (Paramètres > Intégrations)                       | Accès nominatif du contact technique |
| --------- | -------------------------------------------------------------- | ------------------------------------ |
| Gandi     | Jeton personnel (PAT), identifiant d'organisation              | Membre de l'organisation             |
| Scaleway  | Clé secrète d'une application IAM, identifiant du projet       | Membre IAM de l'organisation         |
| GitHub    | Nom de l'organisation, App ID, Installation ID, clé privée PEM | Owner de l'organisation              |
| Resend    | Clé API à accès complet                                        | Membre de l'équipe                   |
| Anthropic | Clé API                                                        | Membre de l'organisation             |

---

## 1. Gandi (domaines et DNS)

**Rôle dans l'outil** : vérifier la disponibilité des domaines, les acheter après
confirmation, écrire les enregistrements DNS (LiveDNS). L'agence est propriétaire
de tous les domaines achetés.

**Durée** : 45 minutes, dont l'achat du domaine technique.

### 1.1 Compte et organisation (le gérant)

1. Sur gandi.net, **Créer un compte** avec la boîte technique. Choisir un nom
   d'utilisateur neutre (par exemple `auscii`), un mot de passe fort, valider l'email.
2. Activer la double authentification : menu utilisateur (en haut à droite) >
   **Paramètres du compte** > **Sécurité** > Authentification à deux facteurs >
   application d'authentification. Noter les codes de secours.
3. Créer l'organisation de l'entreprise : menu **Organisations** > **Créer une
   organisation** > type « Entreprise » : raison sociale, SIRET ou TVA, adresse,
   téléphone. C'est cette organisation qui possède les domaines et qui est facturée.
   Le compte personnel créé à l'étape 1 devient son administrateur.
4. Moyen de paiement : dans l'organisation, **Facturation** > **Moyens de
   paiement** > ajouter la carte de l'entreprise. Gandi propose aussi un compte
   prépayé : inutile ici, le renouvellement automatique se sert sur la carte.

### 1.2 Inviter le contact technique (le gérant)

1. Le contact technique crée son propre compte Gandi s'il n'en a pas (avec son
   adresse à lui).
2. Dans l'organisation : **Équipe** (ou « Utilisateurs et rôles ») > **Ajouter un
   membre** > saisir le nom d'utilisateur ou l'email du contact technique.
3. Lui donner les droits complets sur les domaines et LiveDNS. Le rôle
   « Administrateur » de l'organisation est le plus simple ; l'alternative est un
   rôle personnalisé avec au moins : voir et renouveler les domaines, acheter des
   domaines, gérer la configuration technique des domaines, gérer LiveDNS.
4. Le contact technique accepte l'invitation depuis son email.

### 1.3 Acheter le domaine technique (le gérant, guidé)

1. Barre de recherche Gandi : saisir le domaine choisi (`auscii.site`), vérifier
   qu'il est disponible, l'ajouter au panier.
2. Au paiement, vérifier que **le propriétaire est l'organisation AUSCII**, pas le
   compte personnel, et que le renouvellement automatique est activé.
3. Laisser les serveurs de noms par défaut (LiveDNS). L'outil écrira les
   enregistrements dedans.
4. Une fois le domaine actif, créer un premier enregistrement à la main : dans le
   domaine > **Enregistrements DNS** > **Ajouter** : type `A`, nom `deploy`, valeur
   l'adresse IP du VPS pilote (voir la section Scaleway), TTL par défaut. Sans cet
   enregistrement, le pilote ne peut pas obtenir son certificat HTTPS.

### 1.4 Jeton pour l'outil (le contact technique, connecté avec la boîte technique)

Le jeton est lié à l'utilisateur qui le crée. Pour qu'il ne dépende pas du contact
technique, le créer **connecté avec le compte de la boîte technique** (celui de
l'étape 1.1), pas avec le compte nominatif.

1. Menu utilisateur > **Paramètres du compte** > **Sécurité** > **Jetons d'accès
   personnels (PAT)** > **Créer un jeton**.
2. Nom : `auscii-deploy`. **Organisation liée** : l'organisation AUSCII (pas le compte
   personnel). Durée : la plus longue possible (un an), noter la date d'expiration
   dans l'agenda de l'agence.
3. Droits, au minimum :
   - Voir et renouveler les domaines
   - Acheter des domaines
   - Gérer la configuration technique des domaines
   - Gérer les enregistrements LiveDNS
4. Copier le jeton : il n'est **affiché qu'une fois**. Le ranger dans le gestionnaire
   de mots de passe puis le coller dans l'outil, Paramètres > Intégrations > Gandi >
   « Personal Access Token ». Cliquer **Tester** : l'outil affiche le compte et la
   liste des organisations avec leur identifiant.
5. Recopier l'identifiant de l'organisation AUSCII dans le champ « Identifiant
   d'organisation (sharing_id) », **Enregistrer**, retester.
6. Paramètres > Agence : domaine technique, identifiant d'organisation, et le
   **contact propriétaire complet** (raison sociale, prénom, nom, email, téléphone au
   format `+33.612345678`, adresse, code postal, ville, pays). Gandi refuse tout achat
   avec un contact incomplet.

### 1.5 Pièges

- Un jeton créé « sur le compte personnel » au lieu de l'organisation ne voit pas
  les domaines de l'agence : le test réussit mais la liste des organisations est
  vide ou l'achat échoue.
- L'expiration du jeton coupe les achats et le DNS sans prévenir. Mettre un rappel
  un mois avant. La rotation est décrite dans `runbook.md`.
- Ne jamais transférer `auscii.com` chez Gandi « pour simplifier » : les emails de
  l'agence en dépendent.

---

## 2. Scaleway (serveurs)

**Rôle dans l'outil** : commander automatiquement des VPS quand la capacité est
atteinte, les supprimer depuis l'outil. Scaleway héberge aussi le VPS du pilote et
les sauvegardes (Object Storage).

**Durée** : 1 heure. La vérification d'identité peut prendre plus longtemps.

### 2.1 Compte et organisation (le gérant)

1. Sur console.scaleway.com, **Créer un compte** avec la boîte technique. Choisir un
   compte **Entreprise** (« Corporate ») : raison sociale, adresse, numéro de TVA.
   Le compte crée automatiquement une **Organisation** et un projet `default`.
2. Vérifier l'email, puis le téléphone (SMS).
3. **Facturation** (menu Organisation, en haut à droite > **Billing**) > ajouter la
   carte de l'entreprise. Scaleway effectue une petite empreinte d'autorisation. Une
   vérification d'identité (pièce d'identité) peut être demandée avant de pouvoir
   créer des instances : la faire tout de suite.
4. Double authentification : menu utilisateur > **Profile** (ou « User account ») >
   **Security** > **Multifactor authentication** > application d'authentification.
   Noter les codes de secours.

### 2.2 Inviter le contact technique (le gérant)

1. Menu Organisation (en haut à droite) > **IAM & API keys** > onglet **Users** >
   **Invite user** (ou « Add user ») > l'email du contact technique.
2. Lui attacher une politique tout de suite, ou dans l'onglet **Policies** ensuite :
   **Create policy**, nom `contact-technique`, principal : cet utilisateur, règles :
   - portée **Access to Organization features**, jeu de permissions `IAMManager`
     (pour gérer applications et clés), plus `BillingReadOnly` si on veut qu'il voie
     les factures ;
   - portée **Access to resources**, projet `default`, jeu de permissions
     `AllProductsFullAccess`.
3. Le contact technique accepte l'invitation depuis son email. S'il a déjà un compte
   Scaleway personnel, l'invitation l'ajoute à l'organisation AUSCII sans mélanger
   les deux.

### 2.3 Application et clé pour l'outil (le contact technique)

L'outil s'identifie comme une **application IAM**, pas comme une personne.

1. **IAM & API keys** > onglet **Applications** > **Create application** : nom
   `auscii-deploy`, description « Outil de déploiement des sites clients ».
2. Onglet **Policies** > **Create policy** : nom `auscii-deploy`, principal :
   l'application `auscii-deploy`. Une règle, portée **Access to resources**, projet
   `default`, jeux de permissions :
   - `InstancesFullAccess` (commander et supprimer les serveurs) ;
   - `ProjectReadOnly` (pour que le bouton Tester identifie le projet) ;
   - `ObjectStorageFullAccess` (sauvegardes du pilote, voir 2.5).
3. Onglet **API keys** > **Generate API key** : porteur (« bearer ») l'application
   `auscii-deploy`, description `outil`, pas d'expiration, et **projet préféré**
   `default` (nécessaire pour Object Storage). La console affiche une **Access key**
   et une **Secret key** : la clé secrète n'est **affichée qu'une fois**. Les deux
   vont dans le gestionnaire de mots de passe.
4. Identifiant du projet : menu **Project** (sélecteur en haut à gauche) > projet
   `default` > **Settings** (ou « Project settings ») > **Project ID**, un UUID.
5. Dans l'outil, Paramètres > Intégrations > Scaleway : « Secret key » et « Project
   ID », **Enregistrer**, **Tester** : l'outil affiche le nombre d'offres disponibles
   et le nom du projet.
6. Paramètres > Agence : offre par défaut `DEV1-S`, zone `fr-par-1`.

### 2.4 VPS du pilote (le contact technique)

Le serveur qui héberge l'outil lui-même se commande à la main, une seule fois.

1. Menu **Project** > **SSH keys** > ajouter la clé publique SSH du contact
   technique (celle de son poste), pour l'installation.
2. **Instances** > **Create Instance** : zone `fr-par-1` (ou `fr-par-2`), offre
   `DEV1-M` ou équivalent (2 vCPU, 4 Go), image **Debian 12 (Bookworm)**, disque
   40 Go, IP publique IPv4 routée, la clé SSH ci-dessus. Nom : `auscii-pilot`.
3. Noter l'adresse IP publique : c'est la valeur de l'enregistrement `A deploy`
   chez Gandi (section 1.3). L'installation elle-même est décrite dans `runbook.md`.

### 2.5 Sauvegardes (le contact technique)

1. **Object Storage** > **Create bucket** : nom unique, par exemple
   `auscii-deploy-backups`, région `fr-par` (Paris), visibilité **privée**.
2. Les identifiants de la clé créée en 2.3 servent aussi aux sauvegardes : au moment
   de l'installation du pilote, ils vont dans `/opt/auscii-deploy/.env` (variables
   `S3_BUCKET`, `S3_ENDPOINT=https://s3.fr-par.scw.cloud`, `S3_ACCESS_KEY`,
   `S3_SECRET_KEY`).

### 2.6 Pièges

- Une clé générée avec un **utilisateur** comme porteur meurt avec lui. Toujours
  choisir l'application.
- Sans **projet préféré** sur la clé, Object Storage renvoie des erreurs d'accès
  alors que les instances fonctionnent.
- Le groupe de sécurité par défaut de Scaleway laisse tout ouvert ; c'est le pare-feu
  installé par le script de l'outil qui limite aux ports 22, 80 et 443. Ne pas
  restreindre le groupe de sécurité en plus sans savoir pourquoi.
- Les quotas d'un compte neuf sont bas (quelques instances). Si une commande échoue
  pour quota, demander une augmentation dans la console (**Organization** >
  **Quotas**).

---

## 3. GitHub (un dépôt par site)

**Rôle dans l'outil** : conserver l'historique de chaque site dans un dépôt privé,
avec les branches `staging` et `production`. Les gérants n'ont pas besoin de compte
GitHub ; l'outil agit comme une **GitHub App** installée sur l'organisation. GitHub
héberge aussi le code de l'outil et construit ses images.

**Durée** : 45 minutes.

### 3.1 Compte du gérant et organisation (le gérant)

1. Sur github.com, **Sign up** avec la boîte technique, nom d'utilisateur par exemple
   `auscii-tech`. Valider l'email.
2. Double authentification, GitHub l'exige : **Settings** > **Password and
   authentication** > **Two-factor authentication** > application
   d'authentification. Télécharger les codes de secours dans le gestionnaire de
   mots de passe.
3. Créer l'organisation : icône **+** en haut à droite > **New organization** >
   plan **Free**. Nom : `auscii` (s'il est pris, `auscii-agence` ou
   `auscii-web` ; ce nom apparaîtra dans les URL des dépôts). Email de contact : la
   boîte technique. « This organization belongs to » : **A business or institution**,
   avec le nom de l'agence. Passer l'étape d'invitation, on la fait ensuite.
4. Le plan Free suffit : dépôts privés illimités, minutes d'Actions largement
   suffisantes pour construire les images.

### 3.2 Inviter le contact technique (le gérant)

1. Page de l'organisation > **People** > **Invite member** > le nom d'utilisateur
   GitHub du contact technique.
2. Rôle : **Owner**. C'est nécessaire pour créer la GitHub App et transférer le
   dépôt de l'outil. Le gérant reste Owner lui aussi : une organisation doit
   toujours avoir au moins deux Owners, pour ne pas se retrouver bloquée.
3. Le contact technique accepte l'invitation.

### 3.3 Transférer le dépôt de l'outil (le contact technique)

Le code d'`auscii-deploy` est aujourd'hui sous un compte personnel. Il rejoint
l'organisation pour que les images Docker du pilote soient publiées sous le nom de
l'agence.

1. Dépôt `auscii-deploy` > **Settings** > tout en bas, **Danger Zone** >
   **Transfer ownership** > nouveau propriétaire : l'organisation `auscii`. Confirmer
   en tapant le nom du dépôt.
2. Vérifier que les Actions sont autorisées dans l'organisation : **Organization
   settings** > **Actions** > **General** > « Allow all actions and reusable
   workflows ».
3. Pousser un commit sur `main` (ou relancer le dernier run dans **Actions**) : la CI
   publie `ghcr.io/auscii/auscii-deploy-app` et `-worker`. Ces images sont privées.
4. Pour que le pilote puisse les tirer, créer un jeton en lecture sur le compte de la
   boîte technique : **Settings** (du compte, pas de l'organisation) > **Developer
   settings** > **Personal access tokens** > **Tokens (classic)** > **Generate new
   token**, note `pilote ghcr`, portée `read:packages` uniquement, expiration un an.
   Ce jeton sert aux variables `GHCR_USER` et `GHCR_TOKEN` de l'installation.
5. Au lancement de `install.sh`, répondre `auscii` à la question « Propriétaire
   GitHub des images ».

### 3.4 GitHub App pour l'outil (le contact technique)

1. Page de l'organisation > **Settings** > dans la colonne de gauche, tout en bas,
   **Developer settings** > **GitHub Apps** > **New GitHub App**.
2. Remplir :
   - **GitHub App name** : `auscii-deploy` (le nom doit être unique sur tout GitHub ;
     si refusé, `auscii-deploy-app`) ;
   - **Homepage URL** : l'adresse du pilote, `https://deploy.auscii.site` ;
   - **Callback URL** : vide ; laisser décochées les options d'autorisation
     utilisateur ;
   - **Webhook** : **décocher « Active »** (l'outil n'en a pas besoin, et un webhook
     actif exigerait une URL).
3. **Permissions** > **Repository permissions** :
   - **Administration** : Read and write (créer les dépôts) ;
   - **Contents** : Read and write (pousser les versions) ;
   - **Metadata** : Read-only (coché automatiquement).
     Aucune permission d'organisation ni de compte.
4. **Where can this GitHub App be installed?** : **Only on this account**.
5. **Create GitHub App**. La page **General** de l'App affiche l'**App ID** : le
   noter.
6. Toujours sur **General**, tout en bas, **Private keys** > **Generate a private
   key** : un fichier `.pem` se télécharge. C'est la « Clé privée (PEM) » de l'outil.
   Le ranger dans le gestionnaire de mots de passe, puis le supprimer du dossier
   Téléchargements.
7. Colonne de gauche > **Install App** > à côté de l'organisation, **Install** >
   **All repositories** > **Install**. L'URL de la page qui s'ouvre se termine par
   `/settings/installations/<nombre>` : ce nombre est l'**Installation ID**.
8. Dans l'outil, Paramètres > Intégrations > GitHub : organisation (`auscii`), App
   ID, Installation ID, contenu complet du fichier `.pem` (y compris les lignes
   `BEGIN` et `END`). **Enregistrer**, **Tester** : l'outil affiche le nom de l'App
   et le nombre de dépôts accessibles.

### 3.5 Pièges

- **All repositories** à l'installation est indispensable : l'outil crée un dépôt
  par site, une installation limitée à des dépôts choisis ne verrait pas les
  nouveaux.
- Une clé privée régénérée invalide l'ancienne : ressaisir dans l'outil aussitôt.
- Si le dépôt de l'outil reste sous le compte personnel, l'installation fonctionne
  quand même avec `GHCR_OWNER=<compte personnel>`, mais l'agence dépend de ce compte
  pour ses mises à jour.

---

## 4. Resend (emails des formulaires et alertes)

**Rôle dans l'outil** : envoyer les messages des formulaires de contact des sites
clients et les alertes à l'agence. L'expéditeur est `no-reply@<domaine technique>`.

**Durée** : 20 minutes, plus l'attente de la vérification du domaine.

### 4.1 Compte et équipe (le gérant)

1. Sur resend.com, **Sign up** avec la boîte technique et un mot de passe (éviter la
   connexion par GitHub ou Google : le compte doit rester indépendant).
2. Valider l'email. Si le profil propose la double authentification (**Settings** >
   **Security**), l'activer.
3. Resend organise tout par **équipe** (« team »). Renommer l'équipe créée par
   défaut : **Settings** > **Team** > nom `AUSCII`.
4. Plan : le plan gratuit couvre 3 000 emails par mois, 100 par jour, un domaine
   d'envoi. Un seul domaine suffit (le domaine technique sert pour tous les sites).
   Passer au plan Pro (quelques dizaines d'euros par mois) le jour où la limite
   quotidienne bloque des messages : **Settings** > **Billing**, carte de
   l'entreprise.

### 4.2 Inviter le contact technique (le gérant)

**Settings** > **Team** > **Invite** (ou « Members » > « Invite member ») > email du
contact technique, rôle **Admin**. Il accepte depuis son email et crée son propre
accès.

### 4.3 Clé pour l'outil (le contact technique)

1. Menu **API Keys** > **Create API Key** : nom `auscii-deploy`, permission
   **Full access** (l'outil déclare et vérifie lui-même le domaine d'envoi), domaine
   **All domains**.
2. Copier la clé, **affichée une seule fois**, dans le gestionnaire de mots de passe,
   puis dans l'outil : Paramètres > Intégrations > Resend > « API key ».
   L'expéditeur peut rester vide : par défaut `<Agence> <no-reply@<domaine
technique>>`. **Enregistrer**, **Tester**.
3. Ne pas ajouter le domaine à la main dans Resend. Dans l'outil, cliquer
   **Configurer le domaine d'envoi** : l'outil déclare le domaine technique chez
   Resend (région Europe), écrit les enregistrements SPF et DKIM dans LiveDNS chez
   Gandi, puis demande la vérification. Relancer le bouton après quelques minutes
   jusqu'à l'état « vérifié ».
4. **Envoyer un email de test** : le message arrive à l'adresse de l'admin connecté.
5. Paramètres > Agence > **Email des alertes** : l'adresse qui reçoit les alertes
   (une boîte lue tous les jours, pas la boîte technique).

### 4.4 Pièges

- Une clé « Sending access » suffit à envoyer mais pas à configurer le domaine : le
  bouton « Configurer le domaine d'envoi » échouerait. Prendre **Full access**.
- La vérification échoue tant que Gandi n'est pas configuré dans l'outil (les
  enregistrements DNS ne peuvent pas être écrits). Faire Gandi avant Resend.
- Le plafond de 100 emails par jour du plan gratuit compte les alertes et les tests.

---

## 5. Anthropic (rapport Claude à l'étape 3)

Le compte existe déjà. Sur console.anthropic.com, avec un membre de l'organisation
AUSCII : **API Keys** > **Create Key**, nom `auscii-deploy`, dans l'espace de
travail par défaut. Copier la clé dans Paramètres > Intégrations > Anthropic, laisser
le modèle vide, **Enregistrer**, **Tester**. Vérifier que la facturation de la
console (distincte de l'abonnement Claude Code) a un moyen de paiement ou du crédit :
un rapport coûte quelques centimes.

---

## 6. Ordre recommandé et vérification finale

L'ordre évite les dépendances : Gandi avant Resend (DNS), Scaleway avant l'installation
du pilote (IP), GitHub avant l'installation (images).

1. Boîte technique, gestionnaire de mots de passe.
2. Gandi : compte, organisation, domaine technique.
3. Scaleway : compte, application, VPS du pilote. Enregistrement `A deploy` chez
   Gandi avec l'IP obtenue.
4. GitHub : organisation, transfert du dépôt, jeton `read:packages`, GitHub App.
5. Installation du pilote (`runbook.md`, « Installation à blanc »).
6. Dans l'outil : Gandi, Scaleway, GitHub, Resend, Anthropic, chaque fois avec
   **Tester** vert. Puis clé SSH du pilote, domaine d'envoi Resend, contact
   propriétaire et email des alertes.

Vérification finale, à faire ensemble :

- [ ] Chaque compte est ouvert avec la boîte technique, la carte de l'entreprise et
      la double authentification ; les codes de secours sont dans le gestionnaire de
      mots de passe.
- [ ] Le contact technique se connecte partout avec son propre identifiant.
- [ ] Les cinq boutons **Tester** de Paramètres > Intégrations sont verts.
- [ ] Le domaine d'envoi Resend est « vérifié » et l'email de test est arrivé.
- [ ] Les dates d'expiration (jeton Gandi, jeton GHCR) sont dans l'agenda de l'agence.
- [ ] Un premier site de test passe le parcours complet : domaine, préproduction,
      production, formulaire reçu.
