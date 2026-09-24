import { describe, expect, it } from "vitest";
import { previewCaddyBlock, productionCaddyBlock } from "./caddy";
import { relaySecretFor } from "./relay";

const TOKEN = "tok_0123456789abcdefXYZ";

function production() {
  return productionCaddyBlock({
    siteSlug: "dupont",
    hosts: ["dupont.fr", "www.dupont.fr"],
    pilotHost: "deploy.auscii.site",
  });
}

function preview() {
  return previewCaddyBlock({
    siteSlug: "dupont",
    hosts: ["dupont.preview.auscii.site"],
    pilotHost: "deploy.auscii.site",
    previewToken: TOKEN,
  });
}

/** Lines of the forms relay handle, whatever the indentation. */
function formsHandle(block: string): string[] {
  const lines = block.split("\n").map((l) => l.trim());
  const start = lines.indexOf("handle /__forms/* {");
  expect(start).toBeGreaterThan(-1);
  const end = lines.indexOf("handle {", start);
  return lines.slice(start, end);
}

describe("production block", () => {
  it("serves the current release of the site folder on every host", () => {
    const block = production();
    expect(block.startsWith("dupont.fr, www.dupont.fr {")).toBe(true);
    expect(block).toContain("root * /srv/sites/dupont/current");
    expect(block).toContain("try_files {path} {path}/index.html {path}.html");
  });

  it("relays the forms to the pilot's /api/forms with the site slug and its secret", () => {
    const relay = formsHandle(production());
    expect(relay).toContain("request_body {");
    expect(relay).toContain("max_size 64KB");
    expect(relay).toContain("rewrite * /api/forms");
    expect(relay).toContain("reverse_proxy https://deploy.auscii.site {");
    expect(relay).toContain("header_up Host deploy.auscii.site");
    expect(relay).toContain("header_up X-Site dupont");
    expect(relay).toContain(`header_up X-Auscii-Relay ${relaySecretFor("dupont")}`);
    expect(relay).toContain("header_up X-Auscii-Client-Ip {remote_host}");
    expect(relay).toContain("header_up X-Auscii-Site-Host {host}");
    expect(relay.join("\n")).not.toContain("X-Forwarded-Host");
  });

  it("strips the relay headers a visitor could forge, and never marks production as preview", () => {
    const relay = formsHandle(production());
    expect(relay).toContain("request_header -X-Auscii-*");
    expect(relay).toContain("request_header -X-Site");
    expect(relay).toContain("request_header -X-Site-Env");
    expect(relay).toContain("request_header -Cookie");
    expect(relay.join("\n")).not.toContain("header_up X-Site-Env");
    // Stripping runs before reverse_proxy sets the real values.
    expect(relay.indexOf("request_header -X-Auscii-*")).toBeLessThan(
      relay.findIndex((l) => l.startsWith("reverse_proxy")),
    );
  });

  it("hides dotfiles but keeps /.well-known, and sets the security headers", () => {
    const block = production();
    expect(block).toContain("path */.*");
    expect(block).toContain("not path /.well-known/*");
    expect(block).toContain("error @dotfiles 404");
    expect(block).toContain("error @wellKnownDotfiles 404");
    expect(block).toContain("-Server");
    expect(block).toContain("X-Content-Type-Options nosniff");
    expect(block).toContain("Referrer-Policy strict-origin-when-cross-origin");
    expect(block).toContain("rewrite * /404.html");
  });
});

describe("preview block", () => {
  it("serves the preview folder but relays forms under the real site slug", () => {
    const block = preview();
    expect(block).toContain("root * /srv/sites/dupont--preview/current");
    const relay = formsHandle(block);
    expect(relay).toContain("header_up X-Site dupont");
    expect(relay.join("\n")).not.toContain("dupont--preview");
    expect(relay).toContain("header_up X-Site-Env preview");
    expect(relay).toContain(`header_up X-Auscii-Relay ${relaySecretFor("dupont")}`);
    expect(relay).toContain("rewrite * /api/forms");
  });

  it("gates the preview behind the token cookie, with a real redirect", () => {
    const block = preview();
    expect(block).toContain(`@enter path /__preview/${TOKEN}`);
    expect(block).toContain(`auscii_preview=${TOKEN}; Path=/; HttpOnly; Secure`);
    // `redir / 302` would read "/" as a matcher and answer an empty 200.
    expect(block).toContain("redir * / 302");
    expect(block).not.toMatch(/redir \/ 302/);
    expect(block).toContain(`(?:^|;\\s*)auscii_preview=${TOKEN}(?:;|$)`);
    expect(block).toContain("noindex");
    expect(block).toContain("403");
    expect(block).toContain("handle_errors {");
    expect(block).toContain("rewrite * /404.html");
  });

  it("accepts an explicit folder", () => {
    const block = previewCaddyBlock({
      siteSlug: "dupont",
      dir: "dupont--preview",
      hosts: ["dupont.preview.auscii.site"],
      pilotHost: "deploy.auscii.site",
      previewToken: TOKEN,
    });
    expect(block).toContain("root * /srv/sites/dupont--preview/current");
  });
});

describe("input validation", () => {
  const base = {
    siteSlug: "dupont",
    hosts: ["dupont.fr"],
    pilotHost: "deploy.auscii.site",
    previewToken: TOKEN,
  };

  it("requires a token for preview", () => {
    expect(() => previewCaddyBlock({ ...base, previewToken: undefined })).toThrow();
    expect(() => previewCaddyBlock({ ...base, previewToken: "short" })).toThrow(/Jeton/);
    expect(() => previewCaddyBlock({ ...base, previewToken: `${TOKEN}"}` })).toThrow(/Jeton/);
  });

  it("refuses values that could inject Caddy directives", () => {
    expect(() => productionCaddyBlock({ ...base, siteSlug: "dupont--preview" })).toThrow(
      /Identifiant/,
    );
    expect(() => productionCaddyBlock({ ...base, siteSlug: "a b" })).toThrow(/Identifiant/);
    expect(() => productionCaddyBlock({ ...base, hosts: ["dupont.fr {\n}"] })).toThrow(/hôte/);
    expect(() => productionCaddyBlock({ ...base, hosts: [] })).toThrow(/Aucun/);
    expect(() => productionCaddyBlock({ ...base, pilotHost: "evil.fr/x" })).toThrow(/hôte/);
    expect(() => productionCaddyBlock({ ...base, dir: "../etc" })).toThrow(/Dossier/);
    expect(() => productionCaddyBlock({ ...base, dir: "other-site" })).toThrow(/Dossier/);
  });

  it("accepts internationalized domains in punycode", () => {
    expect(productionCaddyBlock({ ...base, hosts: ["xn--boulangerie-dupont-fzb.fr"] })).toContain(
      "xn--boulangerie-dupont-fzb.fr {",
    );
  });
});
