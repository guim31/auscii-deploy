#!/bin/sh
# auscii-deploy — sauvegardes du pilote. Point d'entrée de l'image
# auscii-deploy-backup (voir Dockerfile, cible backup) :
#
#   backup.sh cron    planifie la sauvegarde nocturne à BACKUP_HOUR (heure de TZ)
#                     et lance crond au premier plan (commande par défaut) ;
#   backup.sh run     fait une sauvegarde maintenant :
#                       docker compose run --rm backup run
#   backup.sh check   contrôle de santé du service (dernière sauvegarde réussie
#                     depuis moins de 26 h, dernier envoi S3 réussi).
#
# Une sauvegarde = un dump PostgreSQL (db-<horodatage>.sql.gz) et une archive des
# fichiers de /data (data-<horodatage>.tar.gz), sans les copies de travail git
# (reconstruites depuis GitHub) ni les envois en cours (uploads/).
#
# Chaque fichier est écrit en .tmp, vérifié (gzip -t, taille minimale, fin de
# dump), puis renommé. La rotation locale n'a lieu qu'après une sauvegarde
# complète : 7 quotidiennes, 4 hebdomadaires (copie du dimanche).
#
# Envoi vers Object Storage si S3_BUCKET est renseigné : les fichiers sont
# chiffrés avec age pour BACKUP_AGE_RECIPIENT (clé publique ; la clé privée est
# dans le coffre de l'agence, jamais sur le serveur). Sans destinataire, l'envoi
# est refusé : les dumps contiennent des jetons de session et les messages des
# formulaires (données personnelles).
#
# Codes de sortie de "run" : 0 si la sauvegarde locale est bonne, même quand
# l'envoi S3 échoue (avertissement, état "upload_failed" et ping d'échec) ;
# 1 si le dump ou l'archive échoue. update.sh s'appuie sur cette règle.
#
# Variables : BACKUP_KIND (daily par défaut ; pre-update pour update.sh, sans
# envoi S3 et gardées 5 fois), BACKUP_STAMP (horodatage imposé), BACKUP_HOUR,
# S3_BUCKET, S3_ENDPOINT, S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# BACKUP_AGE_RECIPIENT, BACKUP_PING_URL (surveillance externe type
# healthchecks.io : ping en cas de succès, <url>/fail en cas d'échec).
set -eu
# ash (busybox) connaît pipefail.
# shellcheck disable=SC3040
set -o pipefail

DEST=/backups
STATUS_FILE="$DEST/status"
LOG_FILE="$DEST/backup.log"
LOG_MAX_BYTES=1048576
# Un dump de la base vide (schéma seul) pèse déjà plusieurs Ko compressé.
MIN_DB_BYTES=2048

log() {
	echo "[backup] $(date '+%Y-%m-%d %H:%M:%S %Z') $*"
}

# Le journal persistant vit dans le volume des sauvegardes, avec une rotation
# simple (backup.log, backup.log.1) ; la sortie standard part dans les journaux
# Docker, eux-mêmes limités (docker-compose.yml, logging).
rotate_log() {
	if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE")" -gt "$LOG_MAX_BYTES" ]; then
		mv -f "$LOG_FILE" "$LOG_FILE.1"
	fi
}

ping_monitor() {
	# $1 = "" (succès) ou "/fail"
	[ -n "${BACKUP_PING_URL:-}" ] || return 0
	curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_PING_URL%/}$1" ||
		log "ATTENTION : ping de surveillance impossible ($BACKUP_PING_URL$1)"
}

write_status() {
	# $1 = ok | upload_failed | failed ; $2 = message
	last_success=""
	if [ -f "$STATUS_FILE" ]; then
		last_success=$(sed -n 's/^last_success=//p' "$STATUS_FILE")
	fi
	if [ "$1" != "failed" ]; then
		last_success=$(date +%s)
	fi
	{
		echo "last_run=$(date +%s)"
		echo "last_result=$1"
		echo "last_success=$last_success"
		echo "message=$2"
	} >"$STATUS_FILE.tmp"
	mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

keep_newest() {
	# $1 = motif, $2 = nombre de fichiers à garder
	# $1 est un motif à développer ici.
	# shellcheck disable=SC2012,SC2086
	{ ls -1t $1 2>/dev/null || true; } | tail -n +"$(($2 + 1))" | xargs -r rm -f
}

fail() {
	log "ÉCHEC : $*"
	rm -f "$DB_TMP" "$FILES_TMP"
	write_status failed "$*"
	ping_monitor /fail
	exit 1
}

upload() {
	# Envoie les fichiers chiffrés ; renvoie 1 au premier échec.
	prefix="$(date +%Y/%m)"
	for f in "$@"; do
		enc="$f.age"
		if ! age -r "$BACKUP_AGE_RECIPIENT" -o "$enc" "$f"; then
			rm -f "$enc"
			return 1
		fi
		if ! aws --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" \
			s3 cp --only-show-errors "$enc" "s3://$S3_BUCKET/$prefix/$(basename "$enc")"; then
			rm -f "$enc"
			return 1
		fi
		rm -f "$enc"
	done
}

do_backup() {
	KIND="${BACKUP_KIND:-daily}"
	case "$KIND" in
	daily | pre-update) ;;
	*)
		echo "BACKUP_KIND inconnu : $KIND (daily ou pre-update)" >&2
		exit 2
		;;
	esac
	STAMP="${BACKUP_STAMP:-$(date +%Y%m%d-%H%M%S)}"
	case "$STAMP" in
	*[!0-9A-Za-z_-]*)
		echo "BACKUP_STAMP invalide : $STAMP" >&2
		exit 2
		;;
	esac

	mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/pre-update"
	DIR="$DEST/$KIND"
	DB_FILE="$DIR/db-$STAMP.sql.gz"
	FILES_FILE="$DIR/data-$STAMP.tar.gz"
	DB_TMP="$DB_FILE.tmp"
	FILES_TMP="$FILES_FILE.tmp"

	# Une seule sauvegarde à la fois (cron et update.sh partagent le volume).
	exec 9>"$DEST/.lock"
	if ! flock -n 9; then
		log "une sauvegarde est déjà en cours, abandon"
		exit 1
	fi

	log "$KIND $STAMP : dump de la base"
	if ! pg_dump --host=db --username=auscii --dbname=auscii --no-owner --no-privileges |
		gzip -6 >"$DB_TMP"; then
		fail "pg_dump a échoué (base joignable ? mot de passe ?)"
	fi
	gzip -t "$DB_TMP" || fail "dump corrompu (gzip -t)"
	size=$(wc -c <"$DB_TMP")
	[ "$size" -ge "$MIN_DB_BYTES" ] || fail "dump trop petit ($size octets)"
	gunzip -c "$DB_TMP" | tail -n 5 | grep -q "PostgreSQL database dump complete" ||
		fail "dump incomplet (marqueur de fin absent)"

	log "$KIND $STAMP : archive des fichiers (/data sans git/ ni uploads/)"
	if ! tar -czf "$FILES_TMP" -C /data --exclude=./git --exclude=./uploads .; then
		fail "archive des fichiers impossible"
	fi
	gzip -t "$FILES_TMP" || fail "archive des fichiers corrompue (gzip -t)"

	mv -f "$DB_TMP" "$DB_FILE"
	mv -f "$FILES_TMP" "$FILES_FILE"

	if [ "$KIND" = "daily" ]; then
		# Le dimanche, une copie part dans la rétention hebdomadaire.
		if [ "$(date +%u)" = "7" ]; then
			cp "$DB_FILE" "$FILES_FILE" "$DEST/weekly/"
		fi
		log "rotation locale (7 quotidiennes, 4 hebdomadaires)"
		keep_newest "$DEST/daily/db-*.sql.gz" 7
		keep_newest "$DEST/daily/data-*.tar.gz" 7
		keep_newest "$DEST/weekly/db-*.sql.gz" 4
		keep_newest "$DEST/weekly/data-*.tar.gz" 4
	else
		keep_newest "$DEST/pre-update/db-*.sql.gz" 5
		keep_newest "$DEST/pre-update/data-*.tar.gz" 5
	fi
	rm -f "$DEST"/daily/*.tmp "$DEST"/pre-update/*.tmp

	result=ok
	message="$(basename "$DB_FILE") ($(du -h "$DB_FILE" | cut -f1)), $(basename "$FILES_FILE") ($(du -h "$FILES_FILE" | cut -f1))"
	if [ "$KIND" = "daily" ] && [ -n "${S3_BUCKET:-}" ]; then
		if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
			result=upload_failed
			log "ATTENTION : S3_BUCKET est renseigné mais BACKUP_AGE_RECIPIENT est vide ; envoi refusé (les sauvegardes ne partent jamais en clair)"
		elif [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
			result=upload_failed
			log "ATTENTION : S3_ACCESS_KEY / S3_SECRET_KEY manquantes ; envoi impossible"
		else
			log "envoi chiffré vers s3://$S3_BUCKET/$(date +%Y/%m)/"
			if upload "$DB_FILE" "$FILES_FILE"; then
				log "envoi terminé"
			else
				result=upload_failed
				log "ATTENTION : envoi vers Object Storage en échec ; la sauvegarde locale est conservée"
			fi
		fi
	elif [ "$KIND" = "daily" ]; then
		log "S3 non configuré, sauvegardes locales seulement"
	fi

	write_status "$result" "$message"
	if [ "$result" = ok ]; then
		ping_monitor ""
	else
		ping_monitor /fail
	fi
	log "$KIND $STAMP : terminé, $message"
	# Ligne lue par update.sh.
	echo "BACKUP_DB_FILE=$DB_FILE"
}

do_check() {
	[ -f "$STATUS_FILE" ] || {
		echo "aucune sauvegarde encore faite"
		exit 0
	}
	now=$(date +%s)
	result=$(sed -n 's/^last_result=//p' "$STATUS_FILE")
	last_success=$(sed -n 's/^last_success=//p' "$STATUS_FILE")
	if [ -z "$last_success" ] || [ $((now - last_success)) -gt 93600 ]; then
		echo "pas de sauvegarde réussie depuis plus de 26 h"
		exit 1
	fi
	if [ "$result" != ok ]; then
		echo "dernière sauvegarde : $result ($(sed -n 's/^message=//p' "$STATUS_FILE"))"
		exit 1
	fi
	echo "ok"
}

do_cron() {
	hour="${BACKUP_HOUR:-3}"
	case "$hour" in
	'' | *[!0-9]*)
		echo "BACKUP_HOUR invalide : $hour (0-23)" >&2
		exit 2
		;;
	esac
	[ "$hour" -le 23 ] || {
		echo "BACKUP_HOUR invalide : $hour (0-23)" >&2
		exit 2
	}
	mkdir -p "$DEST"
	# La sortie part dans les journaux du conteneur (PID 1) et dans backup.log.
	echo "0 $hour * * * /usr/local/bin/backup.sh run-logged >/proc/1/fd/1 2>&1" >/etc/crontabs/root
	log "sauvegarde planifiée chaque jour à ${hour}h (${TZ:-UTC})"
	exec crond -f -l 8
}

case "${1:-run}" in
run) do_backup ;;
run-logged)
	rotate_log
	do_backup 2>&1 | tee -a "$LOG_FILE"
	;;
check) do_check ;;
cron) do_cron ;;
*)
	echo "Usage : backup.sh [run|check|cron]" >&2
	exit 2
	;;
esac
