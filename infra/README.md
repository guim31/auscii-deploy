# infra

- `pilot/` : pile Docker du pilote et scripts d'exploitation (voir `docs/runbook.md`).
- `bootstrap-server.sh` : généré par l'outil (Paramètres > Serveurs > Ajouter un serveur existant) à partir de `src/server/deploy/bootstrap.ts`, avec la clé publique du pilote. Le fichier ici est un exemple sans clé, pour lecture ; un test vérifie qu'il reste identique au script généré.
- Le cloud-init des serveurs commandés chez Scaleway enveloppe le même script.

## Serveur de sites (Debian 12)

Le script se lance en root. Il peut être relancé sans risque sur un serveur déjà en service : il remet la configuration en ordre sans toucher aux sites.

| Étape                | Ce qui est fait                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marqueur             | `/var/lib/auscii-ready` est supprimé au début et recréé à la fin : l'outil n'utilise pas le serveur tant que l'installation n'est pas terminée.                                                                                                                 |
| Paquets              | `apt-get -o DPkg::Lock::Timeout=600` : au premier démarrage, apt-daily et unattended-upgrades tiennent le verrou dpkg. `sudo` est installé explicitement.                                                                                                       |
| Utilisateur `deploy` | Clé publique du pilote. Seul droit root : `systemctl reload caddy` (fichier sudoers vérifié par `visudo -cf` avant installation).                                                                                                                               |
| Caddy                | Dépôt officiel. `/etc/caddy/Caddyfile` importe `/etc/caddy/sites/*.caddy`, dossier appartenant à `deploy`. Caddy est redémarré (pas rechargé) quand il rejoint le groupe `deploy`.                                                                              |
| Docker               | Dépôt officiel, installé pour les sites dynamiques de la v2 mais inutilisé en v1. `deploy` n'est **pas** dans le groupe `docker`, qui équivaut à root (il en est retiré s'il y était). Les ports publiés par Docker contournent ufw : n'en publier aucun en v1. |
| SSH                  | `/etc/ssh/sshd_config.d/00-auscii.conf` (lu avant `50-cloud-init.conf`) : pas de mot de passe, root par clé uniquement. `sshd -t` avant rechargement.                                                                                                           |
| Pare-feu             | ufw : le ou les ports SSH réels (`sshd -T`), 80 et 443.                                                                                                                                                                                                         |
| fail2ban             | `jail.local` avec `backend = systemd` (Debian 12 n'a pas d'`auth.log`). Les IP du pilote passées au script sont en `ignoreip`.                                                                                                                                  |
| Mises à jour         | `20auto-upgrades` active unattended-upgrades.                                                                                                                                                                                                                   |

## Arborescence et opérations de l'agent SSH

```
/srv/sites/<slug>/                 production
/srv/sites/<slug>--preview/        préproduction (copie distincte)
    releases/rel-<id>/             une release, immuable, avec le marqueur .auscii-complete
    releases/.tmp-*                extraction en cours (supprimée après 1 h si abandonnée)
    current -> releases/rel-<id>   lien basculé atomiquement
/etc/caddy/sites/<dossier>.caddy   bloc du site ; .caddy.new et .caddy.bak hors du motif importé
/etc/caddy/sites/.auscii.lock      verrou flock de toute modification de la configuration Caddy
```

- **Envoi d'une release** : extraction dans `releases/.tmp-*`, marqueur `.auscii-complete`, puis `mv -T` vers `releases/rel-<id>`. Une release complète n'est jamais réécrite ni supprimée ; un dossier sans marqueur (envoi interrompu d'une ancienne version de l'outil) est remplacé.
- **Déploiement** : dossiers, envoi, écriture et validation du bloc Caddy, bascule de `current`, rechargement de Caddy. Un bloc refusé ne change rien à ce qui est en ligne.
- **Bloc Caddy** : sous verrou, écrit dans `<dossier>.caddy.new` avec contrôle SHA-256 (pas de fichier tronqué), ancienne version gardée en `.bak`, `caddy validate` ; en cas d'échec, l'ancienne version est remise en place. Le rechargement prend le même verrou.
- **Retour arrière** : bascule de `current` vers une release encore présente ; si elle a été purgée, l'outil la renvoie.
- **Purge** : supprime les `rel-*` sauf celles demandées et celle pointée par `current`.
- **Commandes** : délai maximal de 5 min par commande (15 min pour un envoi). La clé d'hôte est enregistrée au premier contact (visible dans les journaux du worker), puis vérifiée.

## Blocs Caddy des sites

- Fichiers cachés (`.env`, `.git/`…) : 404, sauf `/.well-known/` (dont les fichiers cachés restent masqués).
- En-têtes : `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, pas d'en-tête `Server` ; `X-Robots-Tag: noindex` en préproduction.
- Formulaires `/__forms/*` : corps limité à 64 Ko, réécrits vers `/api/forms` du pilote. Les en-têtes `X-Auscii-*`, `X-Site`, `X-Site-Env`, `Cookie` et `Authorization` envoyés par le visiteur sont supprimés ; le bloc ajoute `X-Site` (slug du site, jamais le dossier `--preview`), le secret de relais `X-Auscii-Relay`, `X-Auscii-Client-Ip`, `X-Auscii-Site-Host`, et `X-Site-Env: preview` en préproduction.
- Préproduction : `/__preview/<jeton>` pose le cookie et redirige vers `/` ; sans cookie valide, 403 « Accès réservé ».
