#!/usr/bin/env bash
# auscii-deploy — mise à jour du pilote vers un SHA publié par la CI.
#
#   cd /opt/auscii-deploy && ./update.sh 3f8a1c2
#
# Options : --yes         répond oui à la restauration de la base en cas d'échec ;
#           --skip-files  ne rafraîchit pas les fichiers de la pile depuis src/.
#
# Étapes :
#   1. copie de secours des fichiers de la pile et du .env (.rollback/<date>/) ;
#   2. fichiers de la pile (docker-compose.yml, Caddyfile.pilot, scripts) repris
#      du dépôt cloné dans src/, au commit du tag : pile et images vont ensemble ;
#   3. sauvegarde de la base et des fichiers (pre-update/) ;
#   4. images du nouveau tag ;
#   5. migrations et redémarrage ;
#   6. contrôle de santé (application et worker).
# En cas d'échec après l'étape 4 : retour aux fichiers, au .env et au tag
# précédents, et restauration de la base sauvegardée à l'étape 3 (après
# confirmation), car des migrations ont pu être appliquées.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source ./lib.sh
[ -f .env ] || {
	echo ".env introuvable : ce script se lance depuis /opt/auscii-deploy." >&2
	exit 1
}

ASSUME_YES=0
SYNC_FILES=1
NEW_TAG=""
while [ $# -gt 0 ]; do
	case "$1" in
	--yes) ASSUME_YES=1 ;;
	--skip-files) SYNC_FILES=0 ;;
	-h | --help)
		sed -n '2,19p' "$0"
		exit 0
		;;
	-*)
		echo "Option inconnue : $1" >&2
		exit 1
		;;
	*) NEW_TAG="$1" ;;
	esac
	shift
done
export ASSUME_YES

PREVIOUS_TAG="$(env_get IMAGE_TAG)"
if [ -z "$NEW_TAG" ]; then
	echo "Usage : ./update.sh [--yes] [--skip-files] <sha court publié par la CI>" >&2
	echo "Version actuelle : ${PREVIOUS_TAG:-inconnue}" >&2
	exit 1
fi
if ! valid_tag "$NEW_TAG"; then
	echo "Tag refusé : $NEW_TAG. Il faut le SHA court (7 caractères) publié par la CI, jamais \"latest\"." >&2
	exit 1
fi
if [ "$NEW_TAG" = "$PREVIOUS_TAG" ]; then
	echo "Le pilote tourne déjà sur $NEW_TAG : rien à faire." >&2
	exit 1
fi
echo "Mise à jour : $PREVIOUS_TAG -> $NEW_TAG"

STAMP="$(TZ=Europe/Paris date +%Y%m%d-%H%M%S)"
STACK_FILES=(docker-compose.yml Caddyfile.pilot .env.example update.sh restore.sh prune-images.sh lib.sh)
SNAPSHOT=".rollback/$STAMP"

echo "[1/6] Copie de secours de la pile ($SNAPSHOT)"
install -d -m 700 .rollback "$SNAPSHOT"
for f in "${STACK_FILES[@]}" .env; do
	[ -e "$f" ] && cp -p "$f" "$SNAPSHOT/"
done
# shellcheck disable=SC2012
ls -1dt .rollback/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf

restore_stack_files() {
	for f in "${STACK_FILES[@]}" .env; do
		[ -e "$SNAPSHOT/$f" ] || continue
		cp -p "$SNAPSHOT/$f" "$f.rollback-tmp"
		mv -f "$f.rollback-tmp" "$f"
	done
}

echo "[2/6] Fichiers de la pile"
if [ "$SYNC_FILES" = 0 ]; then
	echo "  --skip-files : fichiers actuels conservés."
elif [ ! -d src/.git ]; then
	echo "  Pas de dépôt dans $(pwd)/src : fichiers actuels conservés (voir docs/runbook.md, « Mise à jour »)."
else
	if ! git -C src fetch --quiet origin; then
		echo "Impossible de récupérer le dépôt (clé de déploiement ?). Relancer avec --skip-files pour ne mettre à jour que les images." >&2
		exit 1
	fi
	COMMIT=$(git -C src rev-parse --verify --quiet "${NEW_TAG}^{commit}" || true)
	if [ -z "$COMMIT" ]; then
		echo "Commit $NEW_TAG introuvable dans le dépôt (branche main poussée ?)." >&2
		exit 1
	fi
	git -C src -c advice.detachedHead=false checkout --quiet --force "$COMMIT"
	for f in "${STACK_FILES[@]}"; do
		[ -f "src/infra/pilot/$f" ] || continue
		# Copie puis renommage : le script en cours garde son ancienne version ;
		# la nouvelle servira à la prochaine mise à jour.
		cp "src/infra/pilot/$f" "$f.new"
		case "$f" in
		*.sh) chmod 750 "$f.new" ;;
		*) chmod 640 "$f.new" ;;
		esac
		if cmp -s "$f.new" "$f"; then
			rm -f "$f.new"
		else
			mv -f "$f.new" "$f"
			echo "  $f mis à jour"
		fi
	done
fi
env_set IMAGE_TAG "$NEW_TAG"
if ! docker compose config -q; then
	echo "La nouvelle pile ne valide pas avec le .env actuel (variable manquante ?)." >&2
	echo "Comparer .env à .env.example, compléter, puis relancer. Retour aux fichiers précédents." >&2
	restore_stack_files
	exit 1
fi

echo "[3/6] Sauvegarde avant mise à jour (sur $PREVIOUS_TAG)"
# L'image de sauvegarde est encore celle du tag précédent.
if ! IMAGE_TAG="$PREVIOUS_TAG" docker compose run --rm -T \
	-e BACKUP_KIND=pre-update -e BACKUP_STAMP="$STAMP" backup run; then
	echo "Sauvegarde impossible : mise à jour annulée, rien n'a changé." >&2
	restore_stack_files
	exit 1
fi
DB_BACKUP="db-$STAMP.sql.gz"

echo "[4/6] Récupération des images $NEW_TAG"
if ! docker compose pull --policy missing; then
	echo "Images introuvables pour le tag $NEW_TAG (CI terminée ? accès GHCR ?). Retour à $PREVIOUS_TAG, rien n'a changé." >&2
	restore_stack_files
	exit 1
fi

rollback() {
	echo >&2
	echo "ÉCHEC : $1" >&2
	echo "Retour à $PREVIOUS_TAG (fichiers de la pile et .env de $SNAPSHOT)." >&2
	restore_stack_files
	if confirm "Restaurer la base sauvegardée avant la mise à jour ($DB_BACKUP) ? Recommandé : des migrations ont pu être appliquées ; les écritures faites depuis le début de la mise à jour seront perdues."; then
		if ! ./restore.sh --yes --no-restart "$DB_BACKUP"; then
			echo "La restauration de la base a échoué. Voir docs/runbook.md, « Incidents »." >&2
		fi
	else
		echo "Base laissée telle quelle. Si l'ancienne version refuse le schéma : ./restore.sh $DB_BACKUP" >&2
	fi
	if docker compose up -d && wait_app_healthy; then
		echo "Retour arrière réussi : le pilote tourne sur $PREVIOUS_TAG." >&2
	else
		echo "Le retour arrière a échoué aussi. Voir docs/runbook.md, « Incidents »." >&2
	fi
	exit 1
}

echo "[5/6] Migrations et redémarrage"
if ! docker compose up -d; then
	docker compose logs --tail 40 migrate >&2 || true
	rollback "migrations ou démarrage en échec (détail : docker compose logs migrate)"
fi

echo "[6/6] Contrôle de santé"
if ! wait_app_healthy; then
	docker compose logs --tail 50 app >&2 || true
	rollback "l'application ne répond pas sur /api/health (détail : docker compose logs app)"
fi
if ! worker_running; then
	docker compose logs --tail 50 worker >&2 || true
	rollback "le worker ne tient pas (détail : docker compose logs worker)"
fi

env_set PREVIOUS_IMAGE_TAG "$PREVIOUS_TAG"
# Seules les images sans étiquette sont supprimées : celles de $PREVIOUS_TAG
# restent, pour un retour arrière (voir prune-images.sh).
docker image prune -f >/dev/null
echo "Pilote à jour sur $NEW_TAG (précédent : $PREVIOUS_TAG, sauvegarde : $DB_BACKUP)."
