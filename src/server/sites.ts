import type { Prisma } from "@prisma/client";
import { rm } from "node:fs/promises";
import { prisma } from "./db";
import { randomToken } from "./crypto";
import { getProviders } from "./providers";
import { getSettings } from "./settings";
import { slugify } from "@/lib/slug";
import { extractSiteZip } from "./releases/intake";
import { analyzeSite, type Analysis } from "./releases/analyze";
import { releaseDir } from "./releases/paths";
import { planPlacement, type PlacementResult } from "./jobs/steps/server";
import { enqueue, QUEUES } from "./jobs/boss";

export type SiteWithRelations = Prisma.SiteGetPayload<{
  include: {
    server: true;
    domainRecord: true;
    releases: { orderBy: { version: "desc" } };
    sslChecks: { orderBy: { checkedAt: "desc" }; take: 1 };
  };
}>;

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "site";
  let slug = root;
  for (let i = 2; i < 100; i++) {
    const exists = await prisma.site.findUnique({ where: { slug } });
    if (!exists) return slug;
    slug = `${root}-${i}`;
  }
  throw new Error("Impossible de générer un identifiant unique");
}

export async function createDraftSite(userId: string, clientName: string) {
  const demo = (await getProviders()).demo;
  return prisma.site.create({
    data: {
      slug: await uniqueSlug(clientName),
      clientName: clientName.trim(),
      previewToken: randomToken(),
      status: "draft",
      isDemo: demo,
      createdById: userId,
    },
  });
}

export type Step1Input = {
  clientName: string;
  fqdn: string;
  owned: boolean;
  formsEmail: string;
  price?: number | null;
  currency?: string | null;
};

export async function saveStep1(siteId: string, input: Step1Input) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const data: Prisma.SiteUpdateInput = {
    clientName: input.clientName.trim(),
    domain: input.fqdn,
    formsEmail: input.formsEmail.trim() || null,
  };
  if (site.status === "draft" && slugify(input.clientName) !== site.slug) {
    data.slug = await uniqueSlug(input.clientName);
  }
  await prisma.site.update({ where: { id: siteId }, data });
  await prisma.domain.upsert({
    where: { siteId },
    create: {
      siteId,
      fqdn: input.fqdn,
      owned: input.owned,
      price: input.price ?? null,
      currency: input.currency ?? null,
      orderStatus: "none",
    },
    update: {
      fqdn: input.fqdn,
      owned: input.owned,
      price: input.price ?? null,
      currency: input.currency ?? null,
    },
  });
  return prisma.site.findUniqueOrThrow({ where: { id: siteId }, include: { domainRecord: true } });
}

export async function placementForSite(siteId: string): Promise<PlacementResult> {
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
    include: { server: true },
  });
  if (site.server) return { kind: "existing", server: site.server };
  const [providers, settings] = await Promise.all([getProviders(), getSettings()]);
  return planPlacement(providers, settings, 0);
}

/** Extracts an uploaded zip into a new release, analyzes it and queues the AI report. */
export async function ingestUpload(siteId: string, zipPath: string, userId: string | null) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const last = await prisma.release.findFirst({ where: { siteId }, orderBy: { version: "desc" } });
  const release = await prisma.release.create({
    data: {
      siteId: site.id,
      version: (last?.version ?? 0) + 1,
      archiveHash: "",
      sizeBytes: 0,
      fileCount: 0,
      createdById: userId,
    },
  });
  const dir = releaseDir(release.id);
  try {
    const extracted = await extractSiteZip(zipPath, dir);
    const analysis = await analyzeSite(dir, extracted.files);
    const updated = await prisma.release.update({
      where: { id: release.id },
      data: {
        archiveHash: extracted.archiveHash,
        sizeBytes: extracted.sizeBytes,
        fileCount: extracted.fileCount,
        analysis: analysis as object,
      },
    });
    await enqueue(QUEUES.aiReport, { releaseId: release.id }, { singletonKey: `ai:${release.id}` });
    return { release: updated, analysis };
  } catch (err) {
    await prisma.release.delete({ where: { id: release.id } }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(zipPath, { force: true });
  }
}

export async function listDashboardSites(demo: boolean) {
  return prisma.site.findMany({
    where: { isDemo: demo, status: { not: "draft" } },
    include: {
      server: true,
      domainRecord: true,
      sslChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
}

export async function getSiteDetail(siteId: string) {
  return prisma.site.findUnique({
    where: { id: siteId },
    include: {
      server: true,
      domainRecord: true,
      releases: { orderBy: { version: "desc" } },
      deployments: { orderBy: { createdAt: "desc" }, take: 30, include: { release: true } },
      sslChecks: { orderBy: { checkedAt: "desc" }, take: 3 },
      submissions: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
}

export function analysisOf(release: { analysis: Prisma.JsonValue | null }): Analysis | null {
  return (release.analysis as Analysis | null) ?? null;
}
