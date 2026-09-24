import { describe, expect, it } from "vitest";
import type { ServerAgent, ServerRef } from "../providers/types";
import { releaseName, siteDir, staticRuntime, type RuntimeDeployInput } from "./runtime";

const server: ServerRef = {
  id: "srv1",
  name: "sites-1",
  ip: "10.0.0.1",
  sshUser: "deploy",
  vcpus: 2,
};

/** Fake agent recording the calls, with a configurable set of present releases. */
function recordingAgent(opts: { present?: string[]; failCaddy?: boolean; current?: string } = {}) {
  const calls: string[] = [];
  const present = new Set(opts.present ?? []);
  let current = opts.current ?? null;
  const caddy: Record<string, string> = {};
  const agent: ServerAgent = {
    name: "recording",
    waitReady: async () => undefined,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    ensureSiteDirs: async (_s, slug) => void calls.push(`dirs ${slug}`),
    uploadRelease: async (_s, slug, _dir, name) => {
      calls.push(`upload ${slug} ${name}`);
      present.add(name);
    },
    hasRelease: async (_s, slug, name) => {
      calls.push(`has ${slug} ${name}`);
      return present.has(name);
    },
    switchRelease: async (_s, slug, name) => {
      calls.push(`switch ${slug} ${name}`);
      current = name;
    },
    pruneReleases: async (_s, slug, keep) => {
      calls.push(`prune ${slug} ${keep.join(",")}`);
      const removed = [...present].filter((r) => r !== current && !keep.includes(r));
      removed.forEach((r) => present.delete(r));
      return removed;
    },
    writeCaddySite: async (_s, slug, config) => {
      calls.push(`caddy ${slug}`);
      if (opts.failCaddy) throw new Error("Configuration Caddy refusée : boom");
      caddy[slug] = config;
    },
    removeCaddySite: async () => undefined,
    reloadCaddy: async () => void calls.push("reload"),
    collectMetrics: async () => {
      throw new Error("unused");
    },
    checkTls: async (host) => ({ host, ok: true }),
  };
  return { agent, calls, caddy, getCurrent: () => current };
}

function input(overrides: Partial<RuntimeDeployInput> = {}): RuntimeDeployInput {
  return {
    server,
    slug: "dupont",
    releaseId: "r2",
    releaseDir: "/data/releases/r2",
    environment: "production",
    hosts: ["dupont.fr", "www.dupont.fr"],
    pilotHost: "deploy.auscii.site",
    previewToken: "tok_0123456789abcdefXYZ",
    log: async () => undefined,
    ...overrides,
  };
}

describe("staticRuntime.deploy", () => {
  it("validates the Caddy block before switching current, then reloads", async () => {
    const { agent, calls } = recordingAgent();
    await staticRuntime.deploy(agent, input());
    expect(calls).toEqual([
      "dirs dupont",
      "has dupont rel-r2",
      "upload dupont rel-r2",
      "caddy dupont",
      "switch dupont rel-r2",
      "reload",
    ]);
  });

  it("leaves production untouched when Caddy refuses the block", async () => {
    const { agent, calls, getCurrent } = recordingAgent({ failCaddy: true, current: "rel-r1" });
    await expect(staticRuntime.deploy(agent, input())).rejects.toThrow(/refusée/);
    expect(calls).not.toContain("switch dupont rel-r2");
    expect(calls).not.toContain("reload");
    expect(getCurrent()).toBe("rel-r1");
  });

  it("does not send a release already on the server (rerun)", async () => {
    const { agent, calls } = recordingAgent({ present: ["rel-r2"] });
    await staticRuntime.deploy(agent, input());
    expect(calls.some((c) => c.startsWith("upload"))).toBe(false);
    expect(calls).toContain("switch dupont rel-r2");
  });

  it("deploys the preview in its own folder with the real site slug in the block", async () => {
    const { agent, calls, caddy } = recordingAgent();
    await staticRuntime.deploy(
      agent,
      input({ environment: "staging", hosts: ["dupont.preview.auscii.site"] }),
    );
    expect(calls).toContain("upload dupont--preview rel-r2");
    expect(calls).toContain("caddy dupont--preview");
    expect(caddy["dupont--preview"]).toContain("root * /srv/sites/dupont--preview/current");
    expect(caddy["dupont--preview"]).toContain("header_up X-Site dupont\n");
  });
});

describe("staticRuntime.rollback", () => {
  it("switches production back when the release is still there", async () => {
    const { agent, calls, getCurrent } = recordingAgent({
      present: ["rel-r1", "rel-r2"],
      current: "rel-r2",
    });
    const ok = await staticRuntime.rollback(agent, {
      server,
      slug: "dupont",
      releaseId: "r1",
      log: async () => undefined,
    });
    expect(ok).toBe(true);
    expect(getCurrent()).toBe("rel-r1");
    expect(calls).not.toContain("reload");
  });

  it("returns false when the release was pruned", async () => {
    const { agent, getCurrent } = recordingAgent({ present: ["rel-r2"], current: "rel-r2" });
    const ok = await staticRuntime.rollback(agent, {
      server,
      slug: "dupont",
      releaseId: "r1",
      log: async () => undefined,
    });
    expect(ok).toBe(false);
    expect(getCurrent()).toBe("rel-r2");
  });
});

describe("staticRuntime.prune", () => {
  it("keeps the given releases and current, in the environment's folder", async () => {
    const { agent, calls } = recordingAgent({
      present: ["rel-a", "rel-b", "rel-c", "rel-d"],
      current: "rel-d",
    });
    const removed = await staticRuntime.prune(agent, {
      server,
      slug: "dupont",
      environment: "staging",
      keepReleaseIds: ["b"],
      log: async () => undefined,
    });
    expect(removed).toBe(2);
    expect(calls).toEqual(["prune dupont--preview rel-b"]);
  });
});

describe("helpers", () => {
  it("names folders and releases", () => {
    expect(siteDir("dupont", "production")).toBe("dupont");
    expect(siteDir("dupont", "staging")).toBe("dupont--preview");
    expect(releaseName("abc")).toBe("rel-abc");
  });
});
