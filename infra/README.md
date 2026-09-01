# infra

- `bootstrap-server.sh` : généré par l'outil (Paramètres > Serveurs > Ajouter un serveur existant) à partir de `src/server/deploy/bootstrap.ts`, avec la clé publique du pilote. Le fichier ici est un exemple sans clé, pour lecture.
- Le cloud-init des serveurs commandés (phase 4) enveloppe le même script.
