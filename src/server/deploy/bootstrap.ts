/**
 * Installation script of a site server (Debian 12): deploy user with the
 * pilot's public key, Caddy, Docker, firewall, SSH hardening, and the
 * readiness marker the SSH agent waits for. Used both by bootstrap-server.sh
 * (existing servers) and by the cloud-init user-data (servers ordered from
 * Scaleway). Idempotent: running it again on a server already in use only
 * converges its configuration, it never touches the sites.
 */
export const READY_MARKER = "/var/lib/auscii-ready";

/** Lines allowed through sudo for the deploy user: nothing but a Caddy reload. */
export const DEPLOY_SUDOERS = "deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy";

/** Keeps a value safe inside single quotes on one line of the script. */
function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/'/g, "")
    .trim();
}

export function bootstrapScript({
  sshPublicKey,
  acmeEmail,
  pilotIps = [],
}: {
  sshPublicKey: string;
  acmeEmail: string;
  /** Addresses of the pilot, never banned by fail2ban (it opens many SSH sessions). */
  pilotIps?: string[];
}): string {
  const key = oneLine(sshPublicKey);
  const ignore = ["127.0.0.1/8", "::1", ...pilotIps.filter((ip) => /^[0-9a-fA-F.:/]+$/.test(ip))];
  return `#!/usr/bin/env bash
# auscii-deploy : préparation d'un serveur de sites (Debian 12), en root.
# Peut être relancé sans risque : il remet la configuration en ordre sans toucher aux sites.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
trap 'echo "Échec à la ligne $LINENO" >&2' ERR

PILOT_KEY='${key}'
ACME_EMAIL='${oneLine(acmeEmail)}'

# Tant que ce marqueur est absent, l'outil considère l'installation en cours.
rm -f ${READY_MARKER}

# Au premier démarrage, apt-daily et unattended-upgrades tiennent le verrou dpkg :
# on attend (10 min) au lieu d'échouer.
apt_get() { apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 -qq "$@"; }
apt_update() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    apt_get update && return 0
    sleep 30
  done
  return 1
}

echo "[1/9] Paquets de base"
apt_update
apt_get install -y sudo ca-certificates curl gnupg ufw fail2ban python3-systemd unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

echo "[2/9] Utilisateur deploy"
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$PILOT_KEY" /home/deploy/.ssh/authorized_keys || echo "$PILOT_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
# Seul droit root de deploy : recharger Caddy. Le fichier est vérifié avant d'être installé.
SUDOERS_TMP=$(mktemp)
echo '${DEPLOY_SUDOERS}' > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null
install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/auscii-deploy
rm -f "$SUDOERS_TMP"

echo "[3/9] Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --batch --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt_update
  apt_get install -y caddy
fi
# deploy écrit les blocs des sites (fichiers <site>.caddy) et les releases.
install -d -m 755 -o deploy -g deploy /etc/caddy/sites /srv/sites
chown -R deploy:deploy /etc/caddy/sites
cat > /etc/caddy/Caddyfile <<CADDY
{
	email $ACME_EMAIL
}
import /etc/caddy/sites/*.caddy
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || {
  echo "Configuration Caddy invalide :" >&2
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >&2
  exit 1
}
# Un nouveau groupe n'est pris en compte qu'au redémarrage du processus, pas au rechargement.
CADDY_RESTART=0
if ! id -nG caddy | tr ' ' '\\n' | grep -qx deploy; then
  usermod -aG deploy caddy
  CADDY_RESTART=1
fi
systemctl enable caddy >/dev/null 2>&1
if [ "$CADDY_RESTART" = 1 ] || ! systemctl is-active --quiet caddy; then
  systemctl restart caddy
else
  systemctl reload caddy
fi

echo "[4/9] Docker (installé pour les sites dynamiques de la v2, inutilisé en v1)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt_update
  apt_get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
# Le groupe docker équivaut à root : deploy n'y est pas (retiré s'il y était).
if id -nG deploy | tr ' ' '\\n' | grep -qx docker; then
  gpasswd -d deploy docker >/dev/null
fi

echo "[5/9] Durcissement SSH"
install -d -m 755 /etc/ssh/sshd_config.d
# 00- : lu avant 50-cloud-init.conf, et c'est la première valeur lue qui l'emporte.
cat > /etc/ssh/sshd_config.d/00-auscii.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
if ! grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config; then
  sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
fi
/usr/sbin/sshd -t
if ! /usr/sbin/sshd -T 2>/dev/null | grep -qx 'passwordauthentication no'; then
  echo "Attention : l'authentification SSH par mot de passe reste active, vérifiez /etc/ssh/sshd_config" >&2
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "[6/9] Pare-feu"
SSH_PORTS=$(/usr/sbin/sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -u)
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
for port in $SSH_PORTS; do
  ufw allow "$port/tcp" >/dev/null
done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "[7/9] fail2ban"
cat > /etc/fail2ban/jail.local <<JAIL
[DEFAULT]
ignoreip = ${ignore.join(" ")}

[sshd]
enabled = true
backend = systemd
port = $(echo $SSH_PORTS | tr ' ' ',')
JAIL
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban

echo "[8/9] Mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "[9/9] Terminé"
touch ${READY_MARKER}
echo "Serveur prêt. Vous pouvez l'ajouter dans auscii-deploy."
`;
}

/** cloud-init user-data wrapping the same script, for servers ordered from the cloud provider. */
export function cloudInitFor(input: {
  sshPublicKey: string;
  acmeEmail: string;
  pilotIps?: string[];
}): string {
  const script = bootstrapScript(input)
    .split("\n")
    .map((l) => (l ? `      ${l}` : l))
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
