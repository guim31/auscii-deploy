import { describe, expect, it } from "vitest";
import { bootstrapScript, cloudInitFor, READY_MARKER } from "./bootstrap";

describe("bootstrap script", () => {
  it("embeds the public key, the ACME email and the readiness marker", () => {
    const s = bootstrapScript({
      sshPublicKey: "ssh-ed25519 AAAAC3 pilot",
      acmeEmail: "admin@auscii.site",
    });
    expect(s).toContain("PILOT_KEY='ssh-ed25519 AAAAC3 pilot'");
    expect(s).toContain("ACME_EMAIL='admin@auscii.site'");
    expect(s).toContain(`touch ${READY_MARKER}`);
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });

  it("strips quotes that would break the shell", () => {
    expect(
      bootstrapScript({ sshPublicKey: "ssh-ed25519 AAAA' rm -rf /", acmeEmail: "a@b" }),
    ).not.toContain("AAAA' rm");
  });

  it("wraps the script in cloud-init", () => {
    const c = cloudInitFor({ sshPublicKey: "k", acmeEmail: "a@b" });
    expect(c.startsWith("#cloud-config")).toBe(true);
    expect(c).toContain("/usr/local/sbin/auscii-bootstrap.sh");
    expect(c).toContain("      #!/usr/bin/env bash");
  });
});
