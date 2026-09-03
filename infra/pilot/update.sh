#!/usr/bin/env bash
# auscii-deploy — mise à jour du pilote vers un tag publié par la CI.
#
#   cd /opt/auscii-deploy && ./update.sh 3f8a1c2
#   ./update.sh latest
#
# Sauvegarde avant, applique les migrations, attend la santé de l'application,
# et revient au tag précédent si elle ne repart pas.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f .env ] || {
	echo ".env introuvable : ce script se lance depuis /opt/auscii-deploy." >&2
	exit 1
}

NEW_TAG="${1:-latest}"
PREVIOUS_TAG=$(grep -E '^IMAGE_TAG=' .env | cut -d= -f2)
echo "Mise à jour : $PREVIOUS_TAG -> $NEW_TAG"

wait_healthy() {
	for _ in $(seq 1 36); do
		local status
		status=$(docker inspect --format '{{.State.Health.Status}}' \
			"$(docker compose ps -q app)" 2>/dev/null || echo starting)
		[ "$status" = "healthy" ] && return 0
		sleep 5
	done
	return 1
}

set_tag() {
	sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$1|" .env
}

echo "[1/5] Sauvegarde"
docker compose run --rm --entrypoint /usr/local/bin/backup.sh backup

echo "[2/5] Récupération des images $NEW_TAG"
set_tag "$NEW_TAG"
if ! docker compose pull; then
	echo "Images introuvables pour le tag $NEW_TAG, retour à $PREVIOUS_TAG." >&2
	set_tag "$PREVIOUS_TAG"
	exit 1
fi

echo "[3/5] Migrations et redémarrage"
docker compose up -d

echo "[4/5] Contrôle de santé"
if wait_healthy; then
	echo "[5/5] Pilote à jour sur $NEW_TAG."
	docker image prune -f >/dev/null
	exit 0
fi

echo "L'application n'est pas repartie, retour à $PREVIOUS_TAG." >&2
docker compose logs --tail 50 app >&2 || true
set_tag "$PREVIOUS_TAG"
docker compose up -d
if wait_healthy; then
	echo "Retour arrière réussi : le pilote tourne sur $PREVIOUS_TAG." >&2
else
	echo "Le retour arrière a échoué aussi. Voir docs/runbook.md, section incidents." >&2
fi
exit 1
