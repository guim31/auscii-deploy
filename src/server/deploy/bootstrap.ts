/**
 * Installation script of a site server (Debian 12): deploy user with the
 * pilot's public key, Caddy, Docker, firewall, and the readiness marker the
 * SSH agent waits for. Used both by bootstrap-server.sh (existing servers)
 * and by the cloud-init user-data (servers ordered from Scaleway).
 */
export const READY_MARKER = "/var/lib/auscii-ready";

export function bootstrapScript({
  sshPublicKey,
  acmeEmail,
}: {
  sshPublicKey: string;
  acmeEmail: string;
}): string {
  const key = sshPublicKey.trim().replace(/'/g, "");
  return `#!/usr/bin/env bash
# auscii-deploy : préparation d'un serveur de sites (Debian 12). À lancer une fois, en root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PILOT_KEY='${key}'
ACME_EMAIL='${acmeEmail.replace(/'/g, "")}'

echo "[1/7] Paquets de base"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

echo "[2/7] Utilisateur deploy"
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$PILOT_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$PILOT_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy' > /etc/sudoers.d/auscii-deploy
chmod 440 /etc/sudoers.d/auscii-deploy

echo "[3/7] Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
install -d -m 755 /etc/caddy/sites /srv/sites
chown -R deploy:deploy /etc/caddy/sites /srv/sites
cat > /etc/caddy/Caddyfile <<CADDY
{
	email $ACME_EMAIL
}
import /etc/caddy/sites/*.caddy
CADDY
usermod -aG deploy caddy 2>/dev/null || true
systemctl enable --now caddy
systemctl reload caddy

echo "[4/7] Docker (prêt pour les sites dynamiques, v2)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker deploy

echo "[5/7] Pare-feu"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "[6/7] Durcissement SSH"
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

echo "[7/7] Terminé"
touch ${READY_MARKER}
echo "Serveur prêt. Vous pouvez l'ajouter dans auscii-deploy."
`;
}

/** cloud-init user-data wrapping the same script, for servers ordered from the cloud provider. */
export function cloudInitFor(input: { sshPublicKey: string; acmeEmail: string }): string {
  const script = bootstrapScript(input)
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
  return `#cloud-config
write_files:
  - path: /usr/local/sbin/auscii-bootstrap.sh
    permissions: "0755"
    content: |
${script}
runcmd:
  - /usr/local/sbin/auscii-bootstrap.sh
`;
}
