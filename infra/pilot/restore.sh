#!/usr/bin/env bash
# auscii-deploy — restauration du pilote depuis une sauvegarde.
#
#   ./restore.sh db-20260903-030000.sql.gz data-20260903-030000.tar.gz
#
# Les archives sont cherchées dans le volume des sauvegardes (daily/ puis weekly/).
# Pour repartir d'Object Storage, les rapatrier d'abord :
#   aws --endpoint-url "$S3_ENDPOINT" s3 cp s3://<bucket>/<année>/<mois>/<fichier> .
#   docker compose cp <fichier> backup:/backups/daily/
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
DB_ARCHIVE="${1:-}"
FILES_ARCHIVE="${2:-}"

find_and_run() {
	# $1 = nom d'archive, $2 = script sh exécuté avec $ARCHIVE pointant sur le fichier trouvé
	docker compose --profile tools run --rm -e ARCHIVE="$1" --entrypoint sh restore -c '
    set -e
    found=""
    for d in daily weekly; do
      if [ -f "/backups/$d/$ARCHIVE" ]; then found="/backups/$d/$ARCHIVE"; break; fi
    done
    if [ -z "$found" ]; then echo "Archive $ARCHIVE introuvable." >&2; exit 1; fi
    ARCHIVE="$found"
    '"$2"'
  '
}

if [ -z "$DB_ARCHIVE" ]; then
	echo "Usage : ./restore.sh <dump-base.sql.gz> [archive-fichiers.tar.gz]" >&2
	echo "Sauvegardes disponibles :" >&2
	docker compose --profile tools run --rm --entrypoint sh restore -c \
		'ls -1t /backups/daily /backups/weekly 2>/dev/null' >&2
	exit 1
fi

cat <<TXT
Restauration du pilote
  base     : $DB_ARCHIVE
  fichiers : ${FILES_ARCHIVE:-(inchangés)}

Cette opération REMPLACE les données actuelles.
TXT
read -rp "Tapez RESTAURER pour confirmer : " CONFIRM
[ "$CONFIRM" = "RESTAURER" ] || {
	echo "Annulé."
	exit 1
}

echo "[1/4] Arrêt de l'application et du worker"
docker compose stop app worker

echo "[2/4] Restauration de la base"
find_and_run "$DB_ARCHIVE" \
	'gunzip -c "$ARCHIVE" | psql --host=db --username=auscii --dbname=auscii --quiet'

if [ -n "$FILES_ARCHIVE" ]; then
	echo "[3/4] Restauration des fichiers des sites"
	find_and_run "$FILES_ARCHIVE" 'tar -xzf "$ARCHIVE" -C /data'
else
	echo "[3/4] Fichiers des sites inchangés"
fi

echo "[4/4] Redémarrage"
docker compose up -d
echo "Restauration terminée. Vérifiez https://$(grep -E '^PILOT_HOST=' .env | cut -d= -f2)"
