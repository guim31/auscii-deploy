#!/usr/bin/env bash
# auscii-deploy — installation du pilote sur un VPS Debian 12 neuf, en root.
#
#   git clone https://github.com/<org>/auscii-deploy /tmp/auscii-deploy
#   bash /tmp/auscii-deploy/infra/pilot/install.sh
#
# Idempotent : relancer le script ne détruit ni la base ni le .env existant.
set -euo pipefail

TARGET=/opt/auscii-deploy
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || {
	echo "À lancer en root." >&2
	exit 1
}

echo "[1/8] Paquets de base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades openssl

echo "[2/8] Docker"
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "[3/8] Fichiers dans $TARGET"
install -d -m 750 "$TARGET"
install -m 640 "$SRC/docker-compose.yml" "$SRC/Caddyfile.pilot" "$TARGET/"
install -m 750 "$SRC/backup.sh" "$SRC/update.sh" "$SRC/restore.sh" "$TARGET/"
install -m 640 "$SRC/.env.example" "$TARGET/"
cd "$TARGET"

echo "[4/8] Configuration"
if [ -f .env ]; then
	echo "  .env déjà présent, conservé tel quel."
else
	read -rp "  Nom d'hôte du pilote (ex. deploy.auscii.site) : " PILOT_HOST
	read -rp "  Email pour Let's Encrypt : " ACME_EMAIL
	read -rp "  Propriétaire GitHub des images (ex. guim31) : " GHCR_OWNER
	read -rp "  Email du premier administrateur : " ADMIN_EMAIL
	read -rsp "  Mot de passe de cet administrateur (8 caractères minimum) : " ADMIN_PASSWORD
	echo
	sed \
		-e "s|^PILOT_HOST=.*|PILOT_HOST=$PILOT_HOST|" \
		-e "s|^ACME_EMAIL=.*|ACME_EMAIL=$ACME_EMAIL|" \
		-e "s|^GHCR_OWNER=.*|GHCR_OWNER=$GHCR_OWNER|" \
		-e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$ADMIN_EMAIL|" \
		-e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" \
		-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
		-e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" \
		-e "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
		.env.example >.env
	echo "  .env créé avec des secrets tirés au hasard."
fi
chmod 600 .env

echo "[5/8] Pare-feu et durcissement"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh 2>/dev/null || systemctl restart sshd
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo "[6/8] Images"
if [ -n "${GHCR_TOKEN:-}" ]; then
	echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-${USER:-root}}" --password-stdin
fi
docker compose pull

echo "[7/8] Démarrage (migrations, compte admin, application)"
docker compose up -d

echo "[8/8] Contrôle de santé"
for _ in $(seq 1 30); do
	status=$(docker inspect --format '{{.State.Health.Status}}' \
		"$(docker compose ps -q app)" 2>/dev/null || echo starting)
	[ "$status" = "healthy" ] && break
	sleep 5
done
if [ "${status:-}" != "healthy" ]; then
	echo "L'application n'est pas saine. Journaux : docker compose logs app" >&2
	exit 1
fi

HOST=$(grep -E '^PILOT_HOST=' .env | cut -d= -f2)
cat <<EOF

Pilote installé.

  Interface : https://$HOST
  Connexion : le compte administrateur saisi plus haut.

Étapes suivantes :
  1. Vérifier que $HOST pointe bien vers ce serveur (le certificat est émis dans la minute).
  2. Paramètres > Agence : domaine technique, contact propriétaire, email des alertes.
  3. Paramètres > Intégrations : clés Gandi, Scaleway, GitHub, Resend, Anthropic, puis « Tester ».
  4. Paramètres > Intégrations : générer la paire de clés SSH du pilote.

Exploitation : ./update.sh <tag>, ./backup.sh, ./restore.sh — voir docs/runbook.md.
EOF
