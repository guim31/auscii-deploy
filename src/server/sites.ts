import { Prisma } from "@prisma/client";
import { rm } from "node:fs/promises";
import { prisma } from "./db";
import { randomToken } from "./crypto";
import { getProviders } from "./providers";
import { getSettings } from "./settings";
import { slugify } from "@/lib/slug";
import { extractSiteZip } from "./releases/intake";
import { analyzeSite } from "./releases/analyze";
import { releaseDir } from "./releases/paths";
import { planPlacement, type PlacementResult } from "./jobs/steps/server";
import { enqueue, QUEUES } from "./jobs/boss";

/** First free slug for a client name; `currentId` lets a site keep its own slug. */
async function uniqueSlug(base: string, currentId?: string): Promise<string> {
  const root = slugify(base) || "site";
  let slug = root;
  for (let i = 2; i < 100; i++) {
    const exists = await prisma.site.findUnique({ where: { slug } });
    if (!exists || exists.id === currentId) return slug;
    slug = `${root}-${i}`;
  }
  throw new Error("Impossible de générer un identifiant unique");
}

/** true when `slug` is the slug of `name` or one of its "-N" variants. */
function slugMatches(slug: string, name: string): boolean {
  const root = slugify(name) || "site";
  return slug === root || new RegExp(`^${root}-\\d+$`).test(slug);
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
  // The slug names the repository, folders and preview host: it only follows the
  // client name while the site is a draft, and never changes for nothing.
  if (site.status === "draft" && !slugMatches(site.slug, input.clientName)) {
    data.slug = await uniqueSlug(input.clientName, site.id);
  }
  await prisma.site.update({ where: { id: siteId }, data });
  const previous = await prisma.domain.findUnique({ where: { siteId } });
  const fqdnChanged = previous !== null && previous.fqdn !== input.fqdn;
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
      // A new name starts from scratch (the caller refuses a change once ordered).
      ...(fqdnChanged
        ? { orderId: null, orderStatus: "none", dnsConfigured: false, expiresAt: null }
        : {}),
    },
  });
  return prisma.site.findUniqueOrThrow({ where: { id: siteId }, include: { domainRecord: true } });
}

export async function placementForSite(siteId: string): Promise<PlacementResult> {
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
    include: { server: true },
  });
  if (site.server && site.server.status !== "retired" && site.server.status !== "retiring")
    return { kind: "existing", server: site.server };
  const [providers, settings] = await Promise.all([
    getProviders({ demo: site.isDemo }),
    getSettings(),
  ]);
  return planPlacement(providers, settings, 0);
}

/** Next version number, retried when two uploads race for the same one. */
async function createReleaseRow(siteId: string, userId: string | null) {
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.release.findFirst({
      where: { siteId },
      orderBy: { version: "desc" },
    });
    try {
      return await prisma.release.create({
        data: {
          siteId,
          version: (last?.version ?? 0) + 1,
          archiveHash: "",
          sizeBytes: 0,
          fileCount: 0,
          createdById: userId,
        },
      });
    } catch (err) {
      const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!conflict || attempt >= 4) throw err;
    }
  }
}

/** Extracts an uploaded zip into a new release, analyzes it and queues the AI report. */
export async function ingestUpload(siteId: string, zipPath: string, userId: string | null) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const release = await createReleaseRow(site.id, userId);
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

/** Drafts of the current mode, so an unfinished wizard can be resumed or deleted. */
export async function listDrafts(demo: boolean) {
  return prisma.site.findMany({
    where: { isDemo: demo, status: "draft" },
    select: { id: true, clientName: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
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
