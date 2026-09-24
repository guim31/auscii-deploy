#!/usr/bin/env bash
# Les scripts entre apostrophes s'exécutent dans le conteneur, pas ici.
# shellcheck disable=SC2016
# auscii-deploy — restauration du pilote depuis une sauvegarde.
#
#   ./restore.sh                                  liste les sauvegardes locales
#   ./restore.sh db-20260903-030000.sql.gz [data-20260903-030000.tar.gz]
#   ./restore.sh --from-s3 2026/09/db-20260903-030000.sql.gz.age [2026/09/data-….tar.gz.age]
#
# Options : --yes (pas de confirmation, pour update.sh et les tests),
#           --no-restart (laisse app, worker et backup arrêtés).
#
# Les archives locales sont cherchées dans le volume des sauvegardes (daily/,
# weekly/, pre-update/, restore/). Avec --from-s3, les fichiers chiffrés sont
# rapatriés depuis S3_BUCKET puis déchiffrés avec la clé privée age du coffre,
# demandée au clavier et jamais écrite sur le disque du serveur. Tout se passe
# dans le conteneur de l'image de sauvegarde : rien à installer sur l'hôte.
#
# La base est remplacée dans une seule transaction (schémas public et pgboss
# supprimés puis recréés depuis le dump) : en cas d'erreur, rien n'est modifié.
# Les fichiers des sites (releases/, screenshots/…) sont remplacés dossier par
# dossier ; les copies de travail git/ sont laissées, elles se resynchronisent
# depuis GitHub.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source ./lib.sh
[ -f .env ] || {
	echo ".env introuvable : ce script se lance depuis /opt/auscii-deploy." >&2
	exit 1
}

ASSUME_YES=0
RESTART=1
FROM_S3=0
ARGS=()
while [ $# -gt 0 ]; do
	case "$1" in
	--yes) ASSUME_YES=1 ;;
	--no-restart) RESTART=0 ;;
	--from-s3) FROM_S3=1 ;;
	-h | --help)
		sed -n '4,23p' "$0"
		exit 0
		;;
	-*)
		echo "Option inconnue : $1" >&2
		exit 1
		;;
	*) ARGS+=("$1") ;;
	esac
	shift
done
export ASSUME_YES
DB_ARCHIVE="${ARGS[0]:-}"
FILES_ARCHIVE="${ARGS[1]:-}"

tools() {
	docker compose --profile tools run --rm -T "$@"
}

if [ -z "$DB_ARCHIVE" ]; then
	echo "Usage : ./restore.sh [--yes] [--no-restart] [--from-s3] <dump-base> [archive-fichiers]" >&2
	echo "Sauvegardes locales disponibles :" >&2
	tools restore -c 'cd /backups && ls -1t daily weekly pre-update restore 2>/dev/null' >&2 || true
	exit 1
fi
for a in "$DB_ARCHIVE" $FILES_ARCHIVE; do
	[[ "$a" =~ ^[A-Za-z0-9._/-]+$ && "$a" != *..* ]] || {
		echo "Nom d'archive invalide : $a" >&2
		exit 1
	}
done

docker compose up -d db >/dev/null

if [ "$FROM_S3" = 1 ]; then
	[ -n "$(env_get S3_BUCKET)" ] || {
		echo "S3_BUCKET est vide dans .env." >&2
		exit 1
	}
	echo "Clé privée age des sauvegardes (AGE-SECRET-KEY-1…, depuis le coffre) :"
	read -rsp "> " AGE_IDENTITY
	echo
	[[ "$AGE_IDENTITY" == AGE-SECRET-KEY-1* ]] || {
		echo "Ce n'est pas une clé privée age." >&2
		exit 1
	}
	LOCAL=()
	for key in "$DB_ARCHIVE" $FILES_ARCHIVE; do
		name="$(basename "$key" .age)"
		echo "Rapatriement de s3://$(env_get S3_BUCKET)/$key"
		# La clé passe par l'entrée standard : ni variable d'environnement, ni fichier sur l'hôte.
		printf '%s\n' "$AGE_IDENTITY" | tools -e KEY="$key" -e NAME="$name" restore -c '
			set -eu
			mkdir -p /backups/restore
			id=$(mktemp)
			trap "rm -f \"$id\" /backups/restore/$NAME.age" EXIT
			cat >"$id"
			aws --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" \
				s3 cp --only-show-errors "s3://$S3_BUCKET/$KEY" "/backups/restore/$NAME.age"
			age -d -i "$id" -o "/backups/restore/$NAME.tmp" "/backups/restore/$NAME.age"
			mv -f "/backups/restore/$NAME.tmp" "/backups/restore/$NAME"
		'
		LOCAL+=("$name")
	done
	unset AGE_IDENTITY
	DB_ARCHIVE="${LOCAL[0]}"
	FILES_ARCHIVE="${LOCAL[1]:-}"
fi

# Exécute $2 dans le conteneur de restauration, avec $ARCHIVE pointant sur le
# fichier $1 trouvé dans le volume des sauvegardes.
with_archive() {
	tools -e ARCHIVE_NAME="$(basename "$1")" restore -c '
		set -eu
		set -o pipefail
		ARCHIVE=""
		for d in daily weekly pre-update restore; do
			if [ -f "/backups/$d/$ARCHIVE_NAME" ]; then ARCHIVE="/backups/$d/$ARCHIVE_NAME"; break; fi
		done
		[ -n "$ARCHIVE" ] || { echo "Archive $ARCHIVE_NAME introuvable dans le volume des sauvegardes." >&2; exit 1; }
		gzip -t "$ARCHIVE" || { echo "Archive $ARCHIVE_NAME corrompue." >&2; exit 1; }
		'"$2"
}

cat <<TXT
Restauration du pilote
  base     : $DB_ARCHIVE
  fichiers : ${FILES_ARCHIVE:-(inchangés)}

Cette opération REMPLACE les données actuelles.
TXT
if [ "$ASSUME_YES" != 1 ]; then
	read -rp "Tapez RESTAURER pour confirmer : " CONFIRM
	[ "$CONFIRM" = "RESTAURER" ] || {
		echo "Annulé."
		exit 1
	}
fi

echo "[1/4] Arrêt de l'application, du worker et des sauvegardes planifiées"
docker compose stop app worker backup

echo "[2/4] Restauration de la base (une seule transaction)"
if ! with_archive "$DB_ARCHIVE" '
		{
			printf "%s\n" "SET client_min_messages TO warning;" "DROP SCHEMA IF EXISTS pgboss CASCADE;" "DROP SCHEMA IF EXISTS public CASCADE;" "CREATE SCHEMA public;"
			gunzip -c "$ARCHIVE"
		} | psql -v ON_ERROR_STOP=1 --single-transaction --quiet --no-psqlrc \
			--host=db --username=auscii --dbname=auscii >/dev/null
	'; then
	echo "Restauration de la base en échec : la base est restée dans son état précédent." >&2
	echo "L'application reste arrêtée ; pour la relancer telle quelle : docker compose up -d" >&2
	exit 1
fi

if [ -n "$FILES_ARCHIVE" ]; then
	echo "[3/4] Restauration des fichiers des sites"
	with_archive "$FILES_ARCHIVE" '
		rm -rf /data/.restore-tmp
		mkdir /data/.restore-tmp
		tar -xzf "$ARCHIVE" -C /data/.restore-tmp
		for entry in /data/.restore-tmp/* /data/.restore-tmp/.[!.]*; do
			[ -e "$entry" ] || continue
			name=$(basename "$entry")
			rm -rf "/data/$name"
			mv "$entry" "/data/$name"
		done
		rmdir /data/.restore-tmp
		chown 1001:1001 /data
	'
else
	echo "[3/4] Fichiers des sites inchangés"
fi

if [ "$RESTART" = 0 ]; then
	echo "[4/4] Redémarrage laissé à l'appelant (--no-restart)"
	exit 0
fi
echo "[4/4] Redémarrage"
docker compose up -d
if wait_app_healthy; then
	echo "Restauration terminée. Vérifiez https://$(env_get PILOT_HOST)"
else
	echo "L'application ne repart pas après la restauration : docker compose logs migrate app" >&2
	exit 1
fi
