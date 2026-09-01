/** cloud-init user-data for a site server: Debian 12, Caddy, Docker, deploy user. */
export function cloudInitFor({
  sshPublicKey,
  pilotHost,
}: {
  sshPublicKey: string;
  pilotHost: string;
}): string {
  return `#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - gnupg
  - ufw
  - fail2ban
  - unattended-upgrades
  - debian-keyring
  - debian-archive-keyring
  - apt-transport-https
users:
  - name: deploy
    shell: /bin/bash
    groups: [docker]
    sudo: "ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy"
    ssh_authorized_keys:
      - ${sshPublicKey}
write_files:
  - path: /etc/caddy/Caddyfile
    content: |
      {
        email admin@${pilotHost}
      }
      import /etc/caddy/sites/*.caddy
runcmd:
  - curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
  - curl -fsSL https://get.docker.com | sh
  - apt-get update && apt-get install -y caddy
  - mkdir -p /etc/caddy/sites /srv/sites
  - chown -R deploy:deploy /etc/caddy/sites /srv/sites
  - systemctl enable --now caddy
  - ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart ssh
  - touch /var/lib/auscii-ready
`;
}
