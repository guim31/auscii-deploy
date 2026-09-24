#!/usr/bin/env bash
# auscii-deploy — libère de la place en supprimant les anciennes images du pilote.
#
#   cd /opt/auscii-deploy && ./prune-images.sh
#
# Garde les images du tag courant (IMAGE_TAG) et du tag précédent
# (PREVIOUS_IMAGE_TAG), nécessaires à un retour arrière, ainsi que celles de
# PostgreSQL et Caddy utilisées par la pile. Ne touche ni aux volumes (base,
# fichiers des sites, sauvegardes, certificats) ni aux conteneurs arrêtés de la
# pile. À préférer à « docker system prune -a », qui supprimerait l'image du tag
# précédent.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source ./lib.sh

CURRENT="$(env_get IMAGE_TAG)"
PREVIOUS="$(env_get PREVIOUS_IMAGE_TAG)"
OWNER="$(env_get GHCR_OWNER)"
[ -n "$CURRENT" ] && [ -n "$OWNER" ] || {
	echo "IMAGE_TAG ou GHCR_OWNER vide dans .env." >&2
	exit 1
}
echo "Images gardées : $CURRENT${PREVIOUS:+ et $PREVIOUS}"

mapfile -t STALE < <(
	docker image ls --format '{{.Repository}}:{{.Tag}}' "ghcr.io/$OWNER/auscii-deploy-*" |
		grep -vE ":(${CURRENT}${PREVIOUS:+|$PREVIOUS})$" || true
)
if [ "${#STALE[@]}" -gt 0 ]; then
	printf '  suppression de %s\n' "${STALE[@]}"
	docker image rm "${STALE[@]}" || true
fi
docker image prune -f >/dev/null
docker builder prune -f >/dev/null 2>&1 || true
df -h / | tail -n 1
