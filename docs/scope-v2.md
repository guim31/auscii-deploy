# Périmètre fonctionnel v2

La v1 est livrée (voir `scope-v1.md` pour ce qu'elle contient). La v2 tient en une
seule fonctionnalité : **l'espace client de relecture**. Les autres idées notées
pendant la v1 sont repoussées sans calendrier, voir « Hors périmètre » plus bas.

## Décisions de cadrage

| Sujet            | Décision                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Besoin           | Supprimer les allers-retours par email pendant la validation d'un site : le client annote directement la préproduction |
| Accès            | Le **lien de préproduction existant** suffit. Aucun compte, aucun mot de passe supplémentaire                          |
| Identité         | Au premier commentaire, le widget demande un **prénom**, conservé dans le navigateur du client (`localStorage`)        |
| Ancrage          | Un commentaire est une **épingle posée sur un élément de la page** : sélecteur CSS et position relative dans l'élément |
| Portée           | Un commentaire appartient à un site et à la version relue ; il reste lisible après une nouvelle version                |
| Où vit le widget | Uniquement dans la **copie de préproduction** des fichiers. Le site en production ne le contient jamais                |
| Retour au gérant | Les commentaires remontent sur la page du site dans l'outil, avec un état « à traiter » ou « traité »                  |
| Notification     | Une alerte email par site et par jour, via le mécanisme d'alertes existant                                             |
| Mode démo        | Le parcours reste démontrable sans réseau, avec des commentaires de démonstration                                      |

## Ce qui rend la chose simple

Deux propriétés de la v1 portent toute la fonctionnalité, il ne faut pas les perdre de vue :

- **La préproduction et la production sont deux copies distinctes sur le serveur.**
  `staticRuntime.deploy()` (`src/server/deploy/runtime.ts`) envoie la préproduction
  dans `/srv/sites/<slug>--preview/` et la production dans `/srv/sites/<slug>/`.
  On peut donc injecter un widget dans la copie relue sans polluer le site en ligne.
- **Le bloc Caddy de préproduction sait déjà relayer vers le pilote.**
  `previewCaddyBlock()` (`src/server/deploy/caddy.ts`) relaie `/__forms/*` avec un
  en-tête `X-Site`, derrière la barrière du cookie de prévisualisation. `/__review/*`
  emprunte exactement le même chemin : pas de nouvelle brique d'infrastructure.

## Parcours du client

1. Il ouvre le lien secret reçu de l'agence (`<slug>.preview.<domaine technique>/__preview/<jeton>`).
2. Un bandeau discret apparaît en bas de page : « Vous relisez ce site. Laisser un commentaire ».
3. Il clique sur le bouton, puis sur la zone de la page dont il veut parler.
4. Au premier commentaire seulement, on lui demande son prénom.
5. Il écrit, valide, et une épingle numérotée reste visible à cet endroit.
6. Il peut rouvrir une épingle pour relire son commentaire, et en poser d'autres sur toutes les pages.

## Parcours du gérant

- La page du site gagne une carte « Retours du client » : les commentaires groupés par page,
  avec l'auteur, la date, la version relue, et un bouton « Marquer comme traité ».
- Le tableau de bord affiche une pastille sur les sites qui ont des retours à traiter.
- Une alerte email prévient l'agence qu'un client a commenté, au plus une fois par site et par jour.

## Entrées non fiables

Le texte et le prénom viennent du client final, donc d'Internet. Même méfiance que
pour les archives déposées et les formulaires de contact :

- Taille bornée, limite de débit par site et par IP comme `/api/forms`.
- Affichage **comme du texte**, jamais interprété comme du HTML.
- Le widget s'exécute dans l'origine du site en préproduction, jamais dans celle de l'outil.
- L'API de relecture ne révèle rien d'un autre site : le site est résolu par l'en-tête `X-Site`.

## Hors périmètre v2

- Comptes clients, rôles supplémentaires, espace client au sens large.
- Validation formelle « bon pour publication » avec signature.
- Notifications en temps réel, fils de discussion, réponses du gérant dans le widget.
- Facturation.
- Repoussés sans calendrier, faute de besoin immédiat :
  - runtime `docker` pour les sites dynamiques (Node, PHP, WordPress) ;
  - génération du site depuis un brief dans l'outil ;
  - multi-registrar et multi-cloud.
