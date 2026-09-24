#!/usr/bin/env bash
# auscii-deploy — installation du pilote sur un VPS Debian 12 neuf, en root.
#
#   git clone git@github.com:<org>/auscii-deploy.git /opt/auscii-deploy/src
#   bash /opt/auscii-deploy/src/infra/pilot/install.sh
#
# Reconstruction sur un nouveau VPS avec le .env conservé dans le coffre :
#   bash /opt/auscii-deploy/src/infra/pilot/install.sh --env /root/auscii.env
#
# Variables facultatives : GHCR_USER et GHCR_TOKEN (PAT classique read:packages)
# si les images sont privées.
#
# Idempotent : relancer le script ne détruit ni la base ni le .env existant.
set -euo pipefail

TARGET=/opt/auscii-deploy
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SRC/../.." && pwd)"
# shellcheck source=lib.sh
source "$SRC/lib.sh"

EXISTING_ENV=""
while [ $# -gt 0 ]; do
	case "$1" in
	--env)
		EXISTING_ENV="${2:?--env attend un chemin}"
		shift 2
		;;
	-h | --help)
		sed -n '2,13p' "$0"
		exit 0
		;;
	*)
		echo "Option inconnue : $1" >&2
		exit 1
		;;
	esac
done

[ "$(id -u)" -eq 0 ] || {
	echo "À lancer en root." >&2
	exit 1
}
[ -t 0 ] || {
	echo "Ce script pose des questions : lancez-le depuis un terminal." >&2
	exit 1
}

ask() {
	# ask VAR "question" [défaut] [regex]
	local var="$1" question="$2" default="${3:-}" pattern="${4:-.+}" answer
	while true; do
		if [ -n "$default" ]; then
			read -rp "  $question [$default] : " answer
			answer="${answer:-$default}"
		else
			read -rp "  $question : " answer
		fi
		if [[ "$answer" =~ $pattern ]]; then
			printf -v "$var" '%s' "$answer"
			return 0
		fi
		echo "  Valeur invalide." >&2
	done
}

HOST_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
EMAIL_RE='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'

# Approximation du domaine enregistrable : les deux derniers labels. Suffisant
# pour .fr, .com, .site ; à vérifier à la main pour un suffixe comme .co.uk.
registrable() {
	awk -F. '{ print $(NF-1) "." $NF }' <<<"$1"
}

echo "[1/10] Paquets de base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq -o DPkg::Lock::Timeout=600 \
	ca-certificates curl gnupg git ufw fail2ban python3-systemd unattended-upgrades openssl >/dev/null

echo "[2/10] Docker et rotation de ses journaux"
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
fi
install -d -m 755 /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
	cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
	systemctl restart docker
fi
systemctl enable --now docker >/dev/null

echo "[3/10] Fichiers de la pile dans $TARGET"
install -d -m 750 "$TARGET"
if [ "$REPO" != "$TARGET/src" ]; then
	echo "  Attention : le dépôt n'est pas cloné dans $TARGET/src ($REPO)."
	echo "  update.sh ne pourra pas rafraîchir les fichiers de la pile tout seul."
fi
install -m 640 "$SRC/docker-compose.yml" "$SRC/Caddyfile.pilot" "$SRC/.env.example" "$TARGET/"
install -m 750 "$SRC/update.sh" "$SRC/restore.sh" "$SRC/prune-images.sh" "$TARGET/"
install -m 640 "$SRC/lib.sh" "$TARGET/"
cd "$TARGET"

echo "[4/10] Configuration"
NEW_ENV=0
if [ -n "$EXISTING_ENV" ]; then
	[ -f "$EXISTING_ENV" ] || {
		echo "  $EXISTING_ENV introuvable." >&2
		exit 1
	}
	if [ -f .env ] && ! cmp -s "$EXISTING_ENV" .env; then
		cp -p .env ".env.before-install.$(date +%Y%m%d-%H%M%S)"
	fi
	install -m 600 "$EXISTING_ENV" .env
	echo "  .env repris depuis $EXISTING_ENV."
elif [ -f .env ]; then
	echo "  .env déjà présent, conservé tel quel."
else
	NEW_ENV=1
	ask PILOT_HOST "Nom d'hôte de l'outil (ex. deploy.auscii.site)" "" "$HOST_RE"
	while true; do
		ask PREVIEW_APP_HOST "Nom d'hôte des aperçus, sur un AUTRE domaine (ex. apercu.auscii-preview.site)" "" "$HOST_RE"
		if [ "$(registrable "$PREVIEW_APP_HOST")" = "$(registrable "$PILOT_HOST")" ]; then
			echo "  Refusé : $PREVIEW_APP_HOST et $PILOT_HOST partagent le domaine $(registrable "$PILOT_HOST")."
			echo "  Les aperçus exécutent le contenu des zips clients : ils doivent vivre sur un domaine distinct."
			continue
		fi
		break
	done
	ask ACME_EMAIL "Email pour Let's Encrypt" "" "$EMAIL_RE"
	ask GHCR_OWNER "Organisation GitHub qui publie les images (ghcr.io/<org>)" "auscii" '^[A-Za-z0-9][A-Za-z0-9-]*$'
	GHCR_OWNER="${GHCR_OWNER,,}"
	DEFAULT_TAG=""
	if git -C "$REPO" rev-parse HEAD >/dev/null 2>&1; then
		DEFAULT_TAG="$(git -C "$REPO" rev-parse HEAD | cut -c1-7)"
	fi
	while true; do
		ask IMAGE_TAG "Tag des images (SHA court publié par la CI)" "$DEFAULT_TAG"
		valid_tag "$IMAGE_TAG" && break
		echo "  Tag invalide (\"latest\" est refusé : il faut un SHA précis pour pouvoir revenir en arrière)."
	done

	cp .env.example .env
	chmod 600 .env
	env_set PILOT_HOST "$PILOT_HOST"
	env_set PREVIEW_APP_HOST "$PREVIEW_APP_HOST"
	env_set ACME_EMAIL "$ACME_EMAIL"
	env_set GHCR_OWNER "$GHCR_OWNER"
	env_set IMAGE_TAG "$IMAGE_TAG"
	env_set PREVIOUS_IMAGE_TAG ""
	env_set POSTGRES_PASSWORD "$(openssl rand -hex 24)"
	env_set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
	env_set APP_ENCRYPTION_KEY "$(openssl rand -hex 32)"
	env_set DEMO_MODE "false"

	echo
	echo "  Sauvegardes vers Scaleway Object Storage (laisser vide pour plus tard,"
	echo "  voir docs/runbook.md) :"
	ask S3_BUCKET "Nom du seau" "-" '^(-|[a-z0-9][a-z0-9.-]{1,62})$'
	if [ "$S3_BUCKET" != "-" ]; then
		ask S3_ACCESS_KEY "Clé d'accès (SCW…)" "" '^[A-Za-z0-9]+$'
		read -rsp "  Clé secrète : " S3_SECRET_KEY
		echo
		env_set S3_BUCKET "$S3_BUCKET"
		env_set S3_ACCESS_KEY "$S3_ACCESS_KEY"
		env_set S3_SECRET_KEY "$S3_SECRET_KEY"
	fi
	echo "  .env créé avec des secrets tirés au hasard."
fi
chmod 600 .env
for key in PILOT_HOST PREVIEW_APP_HOST ACME_EMAIL GHCR_OWNER IMAGE_TAG POSTGRES_PASSWORD BETTER_AUTH_SECRET APP_ENCRYPTION_KEY; do
	[ -n "$(env_get "$key")" ] || {
		echo "  $key est vide dans .env." >&2
		exit 1
	}
done
valid_tag "$(env_get IMAGE_TAG)" || {
	echo "  IMAGE_TAG=$(env_get IMAGE_TAG) refusé : un SHA court publié par la CI est attendu, jamais \"latest\"." >&2
	exit 1
}
docker compose config -q

echo "[5/10] Pare-feu et durcissement"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
# Debian 12 : 50-cloud-init.conf peut autoriser les mots de passe, et la première
# valeur lue l'emporte ; notre fichier 00- est lu avant.
if [ -s /root/.ssh/authorized_keys ] || compgen -G "/home/*/.ssh/authorized_keys" >/dev/null; then
	install -d -m 755 /etc/ssh/sshd_config.d
	cat >/etc/ssh/sshd_config.d/00-auscii.conf <<'SSHD'
# auscii-deploy : connexion par clé uniquement.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
	if sshd -t; then
		systemctl reload ssh 2>/dev/null || systemctl reload sshd
	else
		echo "  Configuration SSH refusée par sshd -t, fichier retiré." >&2
		rm -f /etc/ssh/sshd_config.d/00-auscii.conf
	fi
else
	echo "  Aucune clé SSH autorisée trouvée : mots de passe SSH laissés actifs pour ne pas vous enfermer dehors."
fi
# Debian 12 n'a pas de /var/log/auth.log : fail2ban lit le journal systemd.
cat >/etc/fail2ban/jail.d/00-auscii.local <<'F2B'
[sshd]
enabled = true
backend = systemd
F2B
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo "[6/10] Images $(env_get GHCR_OWNER)/*:$(env_get IMAGE_TAG)"
if [ -n "${GHCR_TOKEN:-}" ]; then
	printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:?GHCR_USER est requis avec GHCR_TOKEN}" --password-stdin
fi
if ! docker compose pull --policy missing; then
	cat >&2 <<TXT
Images introuvables. Vérifier :
  - que la CI a publié le tag $(env_get IMAGE_TAG) (onglet Actions, job « images ») ;
  - pour des images privées : GHCR_USER et GHCR_TOKEN (PAT classique read:packages).
TXT
	exit 1
fi

echo "[7/10] Démarrage (migrations, application, worker, Caddy, sauvegardes)"
if ! docker compose up -d; then
	echo "Démarrage en échec. Migrations : docker compose logs migrate ; application : docker compose logs app" >&2
	exit 1
fi

echo "[8/10] Contrôle de santé"
if ! wait_app_healthy; then
	echo "L'application n'est pas saine. Journaux : docker compose logs app" >&2
	exit 1
fi
if ! worker_running; then
	echo "Le worker ne tourne pas. Journaux : docker compose logs worker" >&2
	exit 1
fi

echo "[9/10] Premier compte administrateur"
if [ "$NEW_ENV" = 1 ]; then
	ask ADMIN_EMAIL "Email du premier administrateur" "" "$EMAIL_RE"
	while true; do
		read -rsp "  Mot de passe (12 caractères minimum) : " ADMIN_PASSWORD
		echo
		read -rsp "  Le même, pour confirmer : " ADMIN_PASSWORD_2
		echo
		if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_2" ]; then
			echo "  Les deux saisies diffèrent."
		elif [ "${#ADMIN_PASSWORD}" -lt 12 ]; then
			echo "  Trop court."
		elif [[ "${ADMIN_PASSWORD,,}" == *change-me* ]]; then
			echo "  Valeur d'exemple refusée."
		else
			break
		fi
	done
	# Le mot de passe passe par l'environnement du processus (ni .env, ni ligne
	# de commande visible dans ps) ; le seed ne touche pas un compte existant.
	export ADMIN_EMAIL ADMIN_PASSWORD
	docker compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_PASSWORD \
		migrate node --import tsx prisma/seed.ts
	unset ADMIN_PASSWORD ADMIN_PASSWORD_2
else
	echo "  .env existant : aucun compte créé (reprise ou restauration)."
fi

echo "[10/10] Clé de chiffrement des sauvegardes et première sauvegarde"
AGE_SECRET=""
if [ -z "$(env_get BACKUP_AGE_RECIPIENT)" ]; then
	AGE_SECRET=$(docker compose run --rm --no-deps -T --entrypoint age-keygen backup 2>/dev/null || true)
	AGE_RECIPIENT="$(sed -n 's/^# public key: //p' <<<"$AGE_SECRET")"
	if [[ "$AGE_RECIPIENT" == age1* ]]; then
		env_set BACKUP_AGE_RECIPIENT "$AGE_RECIPIENT"
		docker compose up -d backup
	else
		AGE_SECRET=""
		echo "  Clé age non générée : les envois vers Object Storage seront refusés tant que" >&2
		echo "  BACKUP_AGE_RECIPIENT est vide (voir docs/runbook.md, « Object Storage »)." >&2
	fi
fi
docker compose run --rm backup run || echo "  Première sauvegarde en échec : docker compose logs backup" >&2

PILOT_HOST="$(env_get PILOT_HOST)"
cat <<EOF

Pilote installé.

  Interface : https://$PILOT_HOST
  Aperçus   : https://$(env_get PREVIEW_APP_HOST) (seul /apercu/* répond)

================================ À FAIRE MAINTENANT ================================
Enregistrer dans le coffre de mots de passe de l'agence :
  1. le fichier $TARGET/.env ENTIER (cat $TARGET/.env). Sans APP_ENCRYPTION_KEY,
     les clés des intégrations et la clé SSH du pilote sont perdues avec le serveur ;
EOF
if [ -n "$AGE_SECRET" ]; then
	cat <<EOF
  2. la clé privée des sauvegardes ci-dessous. Elle n'est PAS gardée sur le serveur :
     sans elle, les sauvegardes d'Object Storage sont illisibles.

$(grep -v '^#' <<<"$AGE_SECRET")
EOF
fi
cat <<EOF
====================================================================================
EOF
read -rp "Tapez OK une fois ces éléments enregistrés dans le coffre : " _ack
while [ "$_ack" != "OK" ]; do
	read -rp "Tapez OK une fois ces éléments enregistrés dans le coffre : " _ack
done
clear 2>/dev/null || true

cat <<EOF
Étapes suivantes :
  1. Vérifier que $PILOT_HOST et $(env_get PREVIEW_APP_HOST) pointent vers ce serveur
     (les certificats sont émis dans la minute).
  2. Paramètres > Agence : domaine technique, domaine des préproductions, contact
     propriétaire, email des alertes.
  3. Paramètres > Intégrations : clés Gandi, Scaleway, GitHub, Resend, Anthropic, puis « Tester ».
  4. Paramètres > Intégrations : générer la paire de clés SSH du pilote.
  5. Surveillance : docs/runbook.md, « Surveillance du pilote » (BACKUP_PING_URL, /api/health).

Exploitation depuis $TARGET : ./update.sh <sha>, ./restore.sh, ./prune-images.sh
EOF
