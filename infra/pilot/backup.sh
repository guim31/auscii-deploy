#!/bin/sh
# auscii-deploy — sauvegarde du pilote. Lancé chaque nuit par le service "backup",
# ou à la main : docker compose exec backup /usr/local/bin/backup.sh
# Produit un dump Postgres et une archive des fichiers des sites, garde 7 copies
# quotidiennes et 4 hebdomadaires en local, et les envoie sur S3 si configuré.
set -eu

STAMP=$(date -u +%Y%m%d-%H%M%S)
DAY=$(date -u +%u) # 7 = dimanche
DEST=/backups
mkdir -p "$DEST/daily" "$DEST/weekly"

DB_FILE="$DEST/daily/db-$STAMP.sql.gz"
FILES_FILE="$DEST/daily/data-$STAMP.tar.gz"

echo "[backup] $STAMP : dump de la base"
pg_dump --host=db --username=auscii --dbname=auscii --no-owner --clean --if-exists |
	gzip -9 >"$DB_FILE"

echo "[backup] $STAMP : archive des fichiers des sites"
tar -czf "$FILES_FILE" -C /data .

# Le dimanche, une copie part dans la rétention hebdomadaire.
if [ "$DAY" = "7" ]; then
	cp "$DB_FILE" "$DEST/weekly/"
	cp "$FILES_FILE" "$DEST/weekly/"
fi

echo "[backup] rotation locale (7 quotidiennes, 4 hebdomadaires)"
# shellcheck disable=SC2012
ls -1t "$DEST"/daily/db-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
# shellcheck disable=SC2012
ls -1t "$DEST"/daily/data-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
# shellcheck disable=SC2012
ls -1t "$DEST"/weekly/db-*.sql.gz 2>/dev/null | tail -n +5 | xargs -r rm -f
# shellcheck disable=SC2012
ls -1t "$DEST"/weekly/data-*.tar.gz 2>/dev/null | tail -n +5 | xargs -r rm -f

if [ -n "${S3_BUCKET:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
	command -v aws >/dev/null 2>&1 || apk add --no-cache aws-cli >/dev/null
	echo "[backup] envoi vers s3://$S3_BUCKET"
	for f in "$DB_FILE" "$FILES_FILE"; do
		aws --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" \
			s3 cp "$f" "s3://$S3_BUCKET/$(date -u +%Y/%m)/$(basename "$f")"
	done
	echo "[backup] envoi terminé"
else
	echo "[backup] S3 non configuré, sauvegardes locales seulement"
fi

echo "[backup] $STAMP : terminé ($(du -sh "$DB_FILE" | cut -f1) base, $(du -sh "$FILES_FILE" | cut -f1) fichiers)"
