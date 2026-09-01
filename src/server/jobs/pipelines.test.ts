import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { createDraftSite, saveStep1 } from "../sites";
import { runPromote, runProvision, runRollback, runStagingDeploy } from "./pipelines";
import { releaseDir } from "../releases/paths";
import { MockServerAgent } from "../providers/agent/mock";
import { MockDomainProvider } from "../providers/domain/mock";
import { MockGitProvider } from "../providers/git/mock";
import { collectAllMetrics } from "./maintenance";

const hasDb = Boolean(process.env.DATABASE_URL);

async function fakeRelease(siteId: string, version: number) {
  const release = await prisma.release.create({
    data: { siteId, version, archiveHash: `h${version}`, sizeBytes: 100, fileCount: 1 },
  });
  const dir = releaseDir(release.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), `<html><title>v${version}</title></html>`);
  return release;
}

describe.skipIf(!hasDb)("pipelines (demo mode, real database)", () => {
  let siteId: string;

  beforeAll(async () => {
    await prisma.site.deleteMany({ where: { slug: { startsWith: "pipeline-test" } } });
    await prisma.server.deleteMany({ where: { isDemo: true } });
    const site = await createDraftSite("test-user", "Pipeline Test");
    siteId = site.id;
    await saveStep1(siteId, {
      clientName: "Pipeline Test",
      fqdn: "pipeline-test.fr",
      owned: false,
      formsEmail: "a@b.fr",
      price: 12.5,
      currency: "EUR",
    });
  });

  afterAll(async () => {
    await prisma.site.deleteMany({ where: { slug: { startsWith: "pipeline-test" } } });
    await prisma.server.deleteMany({ where: { isDemo: true } });
    await rm("./data-test", { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("refuses to order a server without confirmation, then resumes after confirmation", async () => {
    const deployment = await prisma.deployment.create({ data: { siteId, kind: "provision" } });
    await expect(
      runProvision({ deploymentId: deployment.id, confirmServerOrder: false }),
    ).rejects.toThrow(/administrateur/);
    const failed = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(failed.status).toBe("failed");
    expect((failed.steps as { key: string; status: string }[])[0]).toMatchObject({
      key: "server",
      status: "failed",
    });

    await runProvision({ deploymentId: deployment.id, confirmServerOrder: true });
    const done = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(done.status).toBe("succeeded");
    const steps = done.steps as { key: string; status: string }[];
    expect(steps.map((s) => `${s.key}:${s.status}`)).toEqual([
      "server:done",
      "domain:done",
      "dns:done",
      "repo:done",
      "vhost:done",
    ]);

    const site = await prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      include: { server: true, domainRecord: true },
    });
    expect(site.status).toBe("ready");
    expect(site.server?.status).toBe("ready");
    expect(site.server?.ip).toMatch(/^51\.15\./);
    expect(site.domainRecord?.orderStatus).toBe("registered");
    expect(site.domainRecord?.dnsConfigured).toBe(true);
    expect(site.gitRepo).toBe("auscii/pipeline-test");
    expect(MockDomainProvider._records("pipeline-test.fr").map((r) => r.name)).toEqual([
      "@",
      "www",
    ]);
    const logs = await prisma.deploymentLog.count({ where: { deploymentId: deployment.id } });
    expect(logs).toBeGreaterThan(5);
  });

  it("reuses the existing server for a second site", async () => {
    const other = await createDraftSite("test-user", "Pipeline Test Two");
    await saveStep1(other.id, {
      clientName: "Pipeline Test Two",
      fqdn: "pipeline-test-two.fr",
      owned: true,
      formsEmail: "",
      price: null,
      currency: null,
    });
    const d = await prisma.deployment.create({ data: { siteId: other.id, kind: "provision" } });
    await runProvision({ deploymentId: d.id, confirmServerOrder: false });
    const site = await prisma.site.findUniqueOrThrow({ where: { id: other.id } });
    const first = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    expect(site.serverId).toBe(first.serverId);
    const steps = (await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } })).steps as {
      key: string;
      status: string;
    }[];
    expect(steps.find((s) => s.key === "domain")?.status).toBe("skipped");
  });

  it("deploys to staging, promotes to production, then rolls back", async () => {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const r1 = await fakeRelease(siteId, 1);
    const staging = await prisma.deployment.create({
      data: { siteId, kind: "deploy", environment: "staging", releaseId: r1.id },
    });
    await runStagingDeploy({ deploymentId: staging.id });
    let s = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    expect(s.status).toBe("preview");
    expect(s.stagingReleaseId).toBe(r1.id);
    expect(s.previewHost).toBe("pipeline-test.preview.auscii.site");
    expect(s.screenshotPath).toBe(`${siteId}.svg`);
    const host = MockServerAgent._host(site.serverId!);
    expect(host?.sites.get("pipeline-test--preview")?.current).toBe(`rel-${r1.id}`);

    const promote = await prisma.deployment.create({
      data: { siteId, kind: "promote", environment: "production", releaseId: r1.id },
    });
    await runPromote({ deploymentId: promote.id });
    s = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    expect(s.status).toBe("live");
    expect(s.liveReleaseId).toBe(r1.id);
    expect(s.lastPublishedAt).not.toBeNull();
    expect(host?.sites.get("pipeline-test")?.current).toBe(`rel-${r1.id}`);
    expect(MockGitProvider._repo("auscii/pipeline-test")?.tags).toHaveLength(1);
    expect(await prisma.sslCheck.count({ where: { siteId } })).toBeGreaterThanOrEqual(3);

    const r2 = await fakeRelease(siteId, 2);
    const staging2 = await prisma.deployment.create({
      data: { siteId, kind: "deploy", environment: "staging", releaseId: r2.id },
    });
    await runStagingDeploy({ deploymentId: staging2.id });
    const promote2 = await prisma.deployment.create({
      data: { siteId, kind: "promote", environment: "production", releaseId: r2.id },
    });
    await runPromote({ deploymentId: promote2.id });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).liveReleaseId).toBe(
      r2.id,
    );

    const rollback = await prisma.deployment.create({
      data: {
        siteId,
        kind: "rollback",
        environment: "production",
        releaseId: r1.id,
        rollbackOfId: promote2.id,
      },
    });
    await runRollback({ deploymentId: rollback.id });
    s = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    expect(s.liveReleaseId).toBe(r1.id);
    expect(host?.sites.get("pipeline-test")?.current).toBe(`rel-${r1.id}`);
  });

  it("collects metrics for ready servers", async () => {
    const n = await collectAllMetrics();
    expect(n).toBeGreaterThanOrEqual(1);
    const server = await prisma.server.findFirstOrThrow({ where: { isDemo: true } });
    expect(server.metrics).toMatchObject({ vcpus: 2, sitesCount: 2 });
  });
});
