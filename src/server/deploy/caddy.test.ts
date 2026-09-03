import { describe, expect, it } from "vitest";
import { previewCaddyBlock, productionCaddyBlock } from "./caddy";

describe("caddy blocks", () => {
  it("writes a production block with forms proxy", () => {
    const block = productionCaddyBlock({
      slug: "dupont",
      hosts: ["dupont.fr", "www.dupont.fr"],
      pilotHost: "deploy.auscii.site",
    });
    expect(block.startsWith("dupont.fr, www.dupont.fr {")).toBe(true);
    expect(block).toContain("root * /srv/sites/dupont/current");
    expect(block).toContain("reverse_proxy https://deploy.auscii.site");
    expect(block).toContain("header_up X-Site dupont");
  });

  it("gates the preview behind the token cookie", () => {
    const block = previewCaddyBlock({
      slug: "dupont--preview",
      hosts: ["dupont.preview.auscii.site"],
      pilotHost: "deploy.auscii.site",
      previewToken: "tok123",
    });
    expect(block).toContain("@enter path /__preview/tok123");
    expect(block).toContain("auscii_preview=tok123");
    expect(block).toContain("header_up X-Site-Env preview");
    expect(block).toContain("header_up X-Forwarded-Host {host}");
    expect(block).toContain("noindex");
    expect(block).toContain("403");
  });

  it("requires a token for preview", () => {
    expect(() => previewCaddyBlock({ slug: "a", hosts: ["a"], pilotHost: "p" })).toThrow();
  });
});
