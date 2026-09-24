import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapScript, cloudInitFor, DEPLOY_SUDOERS, READY_MARKER } from "./bootstrap";

const EXAMPLE = {
  sshPublicKey: "ssh-ed25519 AAAA... auscii-deploy",
  acmeEmail: "admin@auscii.site",
};

describe("bootstrap script", () => {
  const s = bootstrapScript({
    sshPublicKey: "ssh-ed25519 AAAAC3 pilot",
    acmeEmail: "admin@auscii.site",
  });

  it("embeds the public key, the ACME email and the readiness marker", () => {
    expect(s).toContain("PILOT_KEY='ssh-ed25519 AAAAC3 pilot'");
    expect(s).toContain("ACME_EMAIL='admin@auscii.site'");
    expect(s).toContain(`touch ${READY_MARKER}`);
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });

  it("strips quotes and line breaks that would break the shell", () => {
    const evil = bootstrapScript({
      sshPublicKey: "ssh-ed25519 AAAA' rm -rf /\nrm -rf /",
      acmeEmail: "a@b'\nx",
    });
    expect(evil).not.toContain("AAAA' rm");
    expect(evil).not.toMatch(/^rm -rf \/$/m);
    expect(evil).toContain("ACME_EMAIL='a@b x'");
  });

  it("is valid bash", () => {
    const res = spawnSync("bash", ["-n"], { input: s });
    expect(res.stderr.toString()).toBe("");
    expect(res.status).toBe(0);
  });

  it("removes a stale readiness marker first and sets it last", () => {
    const removed = s.indexOf(`rm -f ${READY_MARKER}`);
    expect(removed).toBeGreaterThan(-1);
    expect(removed).toBeLessThan(s.indexOf("apt_update"));
    expect(s.lastIndexOf(`touch ${READY_MARKER}`)).toBeGreaterThan(s.indexOf("[8/9]"));
  });

  it("waits for the dpkg lock and installs sudo explicitly", () => {
    expect(s).toContain("DPkg::Lock::Timeout=600");
    expect(s).toMatch(/apt_get install -y sudo /);
    expect(s).not.toMatch(/^apt-get install/m);
  });

  it("checks the sudoers file before installing it, and grants only the Caddy reload", () => {
    expect(s).toContain(`echo '${DEPLOY_SUDOERS}'`);
    expect(s.indexOf("visudo -cf")).toBeLessThan(s.indexOf("/etc/sudoers.d/auscii-deploy"));
    expect(s).not.toMatch(/> \/etc\/sudoers\.d/);
  });

  it("keeps deploy out of the docker group (it equals root)", () => {
    expect(s).not.toMatch(/usermod -aG docker deploy/);
    expect(s).toContain("gpasswd -d deploy docker");
    expect(s).not.toContain("get.docker.com");
    expect(s).toContain("download.docker.com/linux/debian");
  });

  it("hardens SSH through a drop-in read before cloud-init's", () => {
    expect(s).toContain("/etc/ssh/sshd_config.d/00-auscii.conf");
    expect(s).toContain("PasswordAuthentication no");
    expect(s).toContain("KbdInteractiveAuthentication no");
    expect(s).toContain("PermitRootLogin prohibit-password");
    expect(s.indexOf("/usr/sbin/sshd -t")).toBeLessThan(s.indexOf("systemctl reload ssh"));
  });

  it("opens the actual SSH port and uses the systemd journal for fail2ban", () => {
    expect(s).toContain("sshd -T 2>/dev/null | awk '/^port /{print $2}'");
    expect(s).toContain('ufw allow "$port/tcp"');
    expect(s).toContain("backend = systemd");
    expect(s).toContain("python3-systemd");
    expect(bootstrapScript({ ...EXAMPLE, pilotIps: ["51.15.1.2", "bad ip; rm"] })).toContain(
      "ignoreip = 127.0.0.1/8 ::1 51.15.1.2\n",
    );
  });

  it("can be run again: non-interactive gpg, restart when caddy joins the deploy group", () => {
    expect(s).not.toMatch(/gpg --dearmor -o/);
    expect(s).toContain("gpg --dearmor --batch --yes");
    expect(s).toContain("usermod -aG deploy caddy");
    expect(s).toContain("systemctl restart caddy");
    expect(s).toContain("20auto-upgrades");
  });

  it("matches the example shipped in infra/", () => {
    const file = readFileSync(path.join(process.cwd(), "infra", "bootstrap-server.sh"), "utf8");
    expect(file).toBe(bootstrapScript(EXAMPLE));
  });
});

describe("cloud-init", () => {
  it("wraps the script in cloud-init", () => {
    const c = cloudInitFor({ sshPublicKey: "k", acmeEmail: "a@b" });
    expect(c.startsWith("#cloud-config")).toBe(true);
    expect(c).toContain("/usr/local/sbin/auscii-bootstrap.sh");
    expect(c).toContain("      #!/usr/bin/env bash");
  });
});
