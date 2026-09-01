import type { ServerAgent, ServerMetrics, ServerRef, TlsCheck } from "../types";
import { hashInt, sleep } from "../mock-utils";

type MockHost = {
  sites: Map<string, { releases: string[]; current: string | null; caddy: string | null }>;
  ready: boolean;
};

const hosts = new Map<string, MockHost>();

function host(server: ServerRef): MockHost {
  let h = hosts.get(server.id);
  if (!h) {
    h = { sites: new Map(), ready: false };
    hosts.set(server.id, h);
  }
  return h;
}

export class MockServerAgent implements ServerAgent {
  readonly name = "mock-ssh";

  async waitReady(server: ServerRef): Promise<void> {
    await sleep(2000);
    host(server).ready = true;
  }

  async exec(server: ServerRef, command: string) {
    await sleep(200);
    host(server);
    return { code: 0, stdout: `[mock ${server.name}] ${command}\n`, stderr: "" };
  }

  async ensureSiteDirs(server: ServerRef, slug: string) {
    await sleep(300);
    const h = host(server);
    if (!h.sites.has(slug)) h.sites.set(slug, { releases: [], current: null, caddy: null });
  }

  async uploadRelease(server: ServerRef, slug: string, _releaseDir: string, releaseName: string) {
    await sleep(1800);
    await this.ensureSiteDirs(server, slug);
    host(server).sites.get(slug)!.releases.push(releaseName);
  }

  async switchRelease(server: ServerRef, slug: string, releaseName: string) {
    await sleep(300);
    const site = host(server).sites.get(slug);
    if (!site || !site.releases.includes(releaseName))
      throw new Error(`Release ${releaseName} absente sur ${server.name}`);
    site.current = releaseName;
  }

  async writeCaddySite(server: ServerRef, slug: string, config: string) {
    await sleep(300);
    await this.ensureSiteDirs(server, slug);
    host(server).sites.get(slug)!.caddy = config;
  }

  async removeCaddySite(server: ServerRef, slug: string) {
    await sleep(200);
    const site = host(server).sites.get(slug);
    if (site) site.caddy = null;
  }

  async reloadCaddy(_server: ServerRef) {
    await sleep(600);
  }

  async collectMetrics(server: ServerRef): Promise<ServerMetrics> {
    await sleep(500);
    const h = host(server);
    const sitesCount = h.sites.size;
    const seed = server.id + sitesCount;
    const diskGb = 20;
    const usedGb = 3.2 + sitesCount * 0.15 + hashInt(seed, 100) / 100;
    return {
      load15: Math.round((0.05 + sitesCount * 0.01 + hashInt(seed + "l", 20) / 100) * 100) / 100,
      vcpus: server.vcpus,
      ramUsedPct: Math.round(28 + sitesCount * 0.4 + hashInt(seed + "r", 10)),
      diskUsedPct: Math.round((usedGb / diskGb) * 100),
      diskFreeBytes: Math.round((diskGb - usedGb) * 1024 ** 3),
      sitesCount,
      collectedAt: new Date().toISOString(),
    };
  }

  async checkTls(hostName: string): Promise<TlsCheck> {
    await sleep(700);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 60 + hashInt(hostName, 25));
    return { host: hostName, ok: true, issuer: "Let's Encrypt (R11)", expiresAt };
  }

  /** Test helper. */
  static _host(serverId: string) {
    return hosts.get(serverId);
  }
}
