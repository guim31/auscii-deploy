/**
 * Optional end-to-end check of the SSH agent against a real server prepared
 * with infra/bootstrap-server.sh. Enabled by TEST_SSH_HOST, TEST_SSH_USER
 * (default deploy) and TEST_SSH_KEY (path of the private key).
 */
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db";
import { SshServerAgent } from "./ssh";
import { productionCaddyBlock } from "../../deploy/caddy";
import type { ServerRef } from "../types";

const host = process.env.TEST_SSH_HOST;
const enabled = Boolean(host && process.env.TEST_SSH_KEY && process.env.DATABASE_URL);

describe.skipIf(!enabled)("SshServerAgent against a real server", () => {
  let agent: SshServerAgent;
  let server: ServerRef;
  let dir: string;
  const slug = "auscii-selftest";

  beforeAll(async () => {
    const row = await prisma.server.create({
      data: {
        name: `selftest-${Date.now()}`,
        provider: "manual",
        ip: host!,
        sshUser: process.env.TEST_SSH_USER ?? "deploy",
        status: "bootstrapping",
        offer: "test",
        vcpus: 1,
      },
    });
    server = { id: row.id, name: row.name, ip: row.ip, sshUser: row.sshUser, vcpus: row.vcpus };
    agent = new SshServerAgent({
      privateKey: readFileSync(process.env.TEST_SSH_KEY!, "utf8"),
      publicKey: "",
    });
    dir = await mkdtemp(path.join(tmpdir(), "auscii-ssh-"));
    await writeFile(path.join(dir, "index.html"), "<h1>selftest</h1>");
  });

  afterAll(async () => {
    await agent.exec(server, `rm -rf /srv/sites/${slug}`).catch(() => undefined);
    await agent.removeCaddySite(server, slug).catch(() => undefined);
    await prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("deploys a release, switches it and validates the Caddy block", async () => {
    await agent.waitReady(server, 30_000);
    await agent.ensureSiteDirs(server, slug);
    await agent.uploadRelease(server, slug, dir, "rel-1");
    await agent.switchRelease(server, slug, "rel-1");
    const current = await agent.exec(
      server,
      `readlink /srv/sites/${slug}/current && cat /srv/sites/${slug}/current/index.html`,
    );
    expect(current.stdout).toContain("releases/rel-1");
    expect(current.stdout).toContain("selftest");
    await agent.writeCaddySite(
      server,
      slug,
      productionCaddyBlock({ slug, hosts: ["selftest.invalid"], pilotHost: "deploy.invalid" }),
    );
    await agent.reloadCaddy(server);
    const metrics = await agent.collectMetrics(server);
    expect(metrics.diskFreeBytes).toBeGreaterThan(0);
    await expect(agent.writeCaddySite(server, slug, "this is { not caddy")).rejects.toThrow(
      /refusée/,
    );
  });
});
