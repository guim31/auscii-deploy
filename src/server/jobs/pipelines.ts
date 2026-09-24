import type { Deployment, DeployEnv, DeployKind } from "@prisma/client";
import { prisma } from "../db";
import { previewHostFor } from "../settings";
import { enqueue, QUEUES } from "./boss";
import { runPipeline, type StepDefinition } from "./pipeline";
import {
  bootstrapServer,
  listCandidates,
  orderServer,
  resumeOrder,
  serverRef,
} from "./steps/server";
import { configureDns, registerDomain, verifyOwnedDomain } from "./steps/domain";
import {
  captureScreenshot,
  checkTls,
  deployRelease,
  productionHosts,
  productionKeepList,
  pruneOldReleases,
} from "./steps/site";
import { runtimeFor } from "../deploy/runtime";
import { pickServer } from "../capacity";
import { ProviderNotConfiguredError } from "../providers/types";
import { describeRecords, expectedDnsRecords } from "../deploy/dns";
import { releaseDir } from "../releases/paths";
import { SERVER_ORDER_CONFIRMATION_REQUIRED } from "@/lib/messages";

export type ProvisionPayload = {
  deploymentId: string;
  zipBytes?: number;
};
export type DeployPayload = { deploymentId: string };

/** Another deployment of the site is queued or running. */
export class DeploymentBusyError extends Error {
  constructor() {
    super(
      "Une opération est déjà en cours sur ce site. Attendez qu'elle se termine avant d'en lancer une autre.",
    );
    this.name = "DeploymentBusyError";
  }
}

type NewDeployment = {
  siteId: string;
  kind: DeployKind;
  environment: DeployEnv | null;
  releaseId: string | null;
  userId: string | null;
  rollbackOfId?: string | null;
  serverOrderConfirmedById?: string | null;
  serverOrderMaxPrice?: number | null;
  domainPurchaseConfirmedById?: string | null;
};

/**
 * Creates a deployment unless the site already has one queued or running. The
 * check and the insert run under a per-site advisory lock, so two clicks (or
 * two people) can never start two operations on the same site.
 */
async function createExclusiveDeployment(input: NewDeployment): Promise<Deployment> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${input.siteId}))`;
    const busy = await tx.deployment.findFirst({
      where: { siteId: input.siteId, status: { in: ["queued", "running"] } },
      select: { id: true },
    });
    if (busy) throw new DeploymentBusyError();
    return tx.deployment.create({
      data: {
        siteId: input.siteId,
        kind: input.kind,
        environment: input.environment,
        releaseId: input.releaseId,
        triggeredById: input.userId,
        rollbackOfId: input.rollbackOfId || null,
        serverOrderConfirmedById: input.serverOrderConfirmedById ?? null,
        serverOrderMaxPrice: input.serverOrderMaxPrice ?? null,
        domainPurchaseConfirmedById: input.domainPurchaseConfirmedById ?? null,
      },
    });
  });
}

// ---------- Provision ----------

const provisionSteps = (payload: ProvisionPayload): StepDefinition[] => [
  {
    key: "server",
    label: "Serveur",
    run: async (ctx) => {
      if (ctx.site.serverId) {
        const s = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId } });
        if (s.status === "ready") return { skipped: `déjà hébergé sur ${s.name}` };
        if (s.status !== "retired" && s.status !== "retiring") {
          // A server ordered by a previous attempt: resume it, never order another one.
          const resumed =
            s.status === "ordering" && !s.providerId
              ? await resumeOrder(s, ctx.providers, ctx.settings, ctx.log)
              : s;
          await bootstrapServer(resumed, ctx.providers, ctx.log);
          return;
        }
        await prisma.site.update({ where: { id: ctx.site.id }, data: { serverId: null } });
        await ctx.refreshSite();
      }
      const candidates = await listCandidates(ctx.site.isDemo);
      const placement = pickServer(candidates, payload.zipBytes ?? 0, ctx.settings.capacity);
      if (placement.kind === "existing") {
        await ctx.log.success(
          `Serveur choisi : ${placement.server.name} (${placement.server.sitesCount} sites)`,
        );
        await prisma.site.update({
          where: { id: ctx.site.id },
          data: { serverId: placement.server.id },
        });
        await ctx.refreshSite();
        return;
      }
      // Paying for a server needs the confirmation of an admin, stored on the deployment.
      if (!ctx.deployment.serverOrderConfirmedById)
        throw new Error(SERVER_ORDER_CONFIRMATION_REQUIRED);
      await ctx.log.warn("Aucun serveur disponible : commande d'un nouveau serveur");
      const server = await orderServer(ctx.providers, ctx.settings, ctx.log, {
        maxMonthlyPrice: ctx.deployment.serverOrderMaxPrice,
        confirmedById: ctx.deployment.serverOrderConfirmedById,
        // Attached before the order: a retry resumes this server instead of ordering another.
        onRow: async (row) => {
          await prisma.site.update({ where: { id: ctx.site.id }, data: { serverId: row.id } });
        },
      });
      await bootstrapServer(server, ctx.providers, ctx.log);
      await ctx.refreshSite();
    },
  },
  {
    key: "domain",
    label: "Nom de domaine",
    run: async (ctx) => {
      const domain = await prisma.domain.findUnique({ where: { siteId: ctx.site.id } });
      if (!domain) throw new Error("Aucun domaine renseigné");
      if (domain.owned) {
        try {
          await verifyOwnedDomain(domain, ctx.providers, ctx.log);
        } catch (err) {
          if (!(err instanceof ProviderNotConfiguredError)) throw err;
          return { skipped: "Gandi non configuré : domaine géré manuellement" };
        }
        return { skipped: `${domain.fqdn} est déjà dans le compte Gandi` };
      }
      if (domain.orderStatus === "registered") return { skipped: "déjà enregistré" };
      if (!ctx.deployment.domainPurchaseConfirmedById)
        throw new Error("L'achat du domaine doit être confirmé par un administrateur (étape 1).");
      try {
        await registerDomain(domain, ctx.providers, ctx.settings, ctx.log, {
          confirmedById: ctx.deployment.domainPurchaseConfirmedById,
        });
      } catch (err) {
        if (!(err instanceof ProviderNotConfiguredError)) throw err;
        await ctx.log.warn(
          `${err.message} Le domaine ${domain.fqdn} doit être acheté et géré manuellement.`,
        );
        return { skipped: "Gandi non configuré : domaine géré manuellement" };
      }
    },
  },
  {
    key: "dns",
    label: "DNS",
    run: async (ctx) => {
      const domain = await prisma.domain.findUniqueOrThrow({ where: { siteId: ctx.site.id } });
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: { previewHost: previewHostFor(ctx.site.slug, ctx.settings) },
      });
      const manual = async (reason: string) => {
        const records = expectedDnsRecords(
          domain.fqdn,
          ctx.site.slug,
          server.ip ?? "?",
          ctx.settings,
        );
        await ctx.log.warn(
          `${reason} Créez ces enregistrements A à la main : ${describeRecords(records)}`,
        );
        return { skipped: `DNS manuel : ${describeRecords(records)}` };
      };
      if (domain.owned && !domain.orderId) {
        try {
          const info = await ctx.providers.domain.getDomain(domain.fqdn);
          if (info && !info.usesProviderDns) return manual(`${domain.fqdn} n'utilise pas LiveDNS.`);
        } catch (err) {
          if (!(err instanceof ProviderNotConfiguredError)) throw err;
        }
      }
      try {
        await configureDns(domain, ctx.site.slug, server, ctx.providers, ctx.settings, ctx.log);
      } catch (err) {
        if (!(err instanceof ProviderNotConfiguredError)) throw err;
        return manual(err.message);
      }
    },
  },
  {
    key: "repo",
    label: "Dépôt GitHub",
    run: async (ctx) => {
      if (ctx.site.gitRepo) return { skipped: `dépôt ${ctx.site.gitRepo} existant` };
      try {
        const repo = await ctx.providers.git.createRepo(ctx.site.slug);
        await ctx.log.success(`Dépôt privé ${repo.fullName} créé (${repo.url})`);
        await prisma.site.update({ where: { id: ctx.site.id }, data: { gitRepo: repo.fullName } });
      } catch (err) {
        if (!(err instanceof ProviderNotConfiguredError)) throw err;
        await ctx.log.warn(`${err.message} Les versions restent conservées sur le pilote.`);
        return { skipped: "GitHub non configuré : versionnement local" };
      }
    },
  },
  {
    key: "vhost",
    label: "Préparation du serveur",
    run: async (ctx) => {
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      await ctx.log.info(`Création des dossiers du site sur ${server.name}`);
      await ctx.providers.agent.ensureSiteDirs(serverRef(server), ctx.site.slug);
      await ctx.providers.agent.ensureSiteDirs(serverRef(server), `${ctx.site.slug}--preview`);
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: { status: ctx.site.liveReleaseId ? "live" : "ready" },
      });
      await ctx.log.success("Infrastructure prête. Vous pouvez déposer le site.");
    },
  },
];

/**
 * Starts (or resumes) the provision of a site. The admin confirmations of the
 * paid actions are stored on the deployment: a later retry reuses them and can
 * never escalate a manager's click into a purchase.
 */
export async function startProvision(
  siteId: string,
  userId: string | null,
  opts: {
    serverOrderConfirmedById?: string | null;
    serverOrderMaxPrice?: number | null;
    domainPurchaseConfirmedById?: string | null;
    zipBytes?: number;
  },
) {
  const failed = await prisma.deployment.findFirst({
    where: { siteId, kind: "provision", status: "failed" },
    orderBy: { createdAt: "desc" },
  });
  let deployment: Deployment;
  if (failed) {
    const claimed = await prisma.deployment.updateMany({
      where: { id: failed.id, status: "failed" },
      data: {
        status: "queued",
        error: null,
        serverOrderConfirmedById: opts.serverOrderConfirmedById ?? failed.serverOrderConfirmedById,
        serverOrderMaxPrice: opts.serverOrderMaxPrice ?? failed.serverOrderMaxPrice,
        domainPurchaseConfirmedById:
          opts.domainPurchaseConfirmedById ?? failed.domainPurchaseConfirmedById,
      },
    });
    if (claimed.count === 0) throw new DeploymentBusyError();
    deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: failed.id } });
  } else {
    deployment = await createExclusiveDeployment({
      siteId,
      kind: "provision",
      environment: null,
      releaseId: null,
      userId,
      ...opts,
    });
  }
  await prisma.site.update({ where: { id: siteId }, data: { status: "provisioning" } });
  await enqueue(
    QUEUES.provision,
    { deploymentId: deployment.id, zipBytes: opts.zipBytes } satisfies ProvisionPayload,
    { singletonKey: `${deployment.id}:${Date.now()}` },
  );
  return deployment;
}

export async function runProvision(payload: ProvisionPayload) {
  await runPipeline(payload.deploymentId, provisionSteps(payload), payload);
}

// ---------- Deploy (staging) ----------

const stagingSteps: StepDefinition[] = [
  {
    key: "push",
    label: "Envoi sur GitHub (préproduction)",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      if (release.commitSha)
        return { skipped: `commit ${release.commitSha.slice(0, 7)} déjà poussé` };
      if (!ctx.site.gitRepo) return { skipped: "pas de dépôt GitHub, versionnement local" };
      const { commitSha } = await ctx.providers.git.pushRelease({
        repo: ctx.site.gitRepo,
        releaseDir: releaseDir(release.id),
        branch: "staging",
        message: `Release v${release.version}`,
      });
      await prisma.release.update({ where: { id: release.id }, data: { commitSha } });
      await ctx.log.success(
        `Version ${release.version} poussée sur staging (${commitSha.slice(0, 7)})`,
      );
    },
  },
  {
    key: "deploy",
    label: "Déploiement en préproduction",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      await deployRelease({
        site: ctx.site,
        server,
        release,
        environment: "staging",
        providers: ctx.providers,
        settings: ctx.settings,
        log: ctx.log,
      });
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: {
          stagingReleaseId: release.id,
          // A site in production stays in production while a new version is reviewed.
          status: ctx.site.liveReleaseId ? "live" : "preview",
          previewHost: previewHostFor(ctx.site.slug, ctx.settings),
        },
      });
      await ctx.refreshSite();
      await pruneOldReleases({
        site: ctx.site,
        server,
        environment: "staging",
        keepReleaseIds: [release.id],
        providers: ctx.providers,
        log: ctx.log,
      });
    },
  },
  {
    key: "tls",
    label: "Certificat HTTPS",
    run: async (ctx) => {
      await checkTls(
        previewHostFor(ctx.site.slug, ctx.settings),
        ctx.site.id,
        ctx.providers,
        ctx.log,
      );
    },
  },
  {
    key: "screenshot",
    label: "Capture d'écran",
    run: async (ctx) => {
      if (ctx.site.liveReleaseId) return { skipped: "la capture de production est conservée" };
      await captureScreenshot(ctx.site, "staging", ctx.providers, ctx.settings, ctx.log);
    },
  },
];

export async function startStagingDeploy(siteId: string, releaseId: string, userId: string | null) {
  const deployment = await createExclusiveDeployment({
    siteId,
    kind: "deploy",
    environment: "staging",
    releaseId,
    userId,
  });
  await enqueue(QUEUES.deploy, { deploymentId: deployment.id } satisfies DeployPayload, {
    singletonKey: deployment.id,
  });
  return deployment;
}

export async function runStagingDeploy(payload: DeployPayload) {
  await runPipeline(payload.deploymentId, stagingSteps);
}

// ---------- Promote (production) ----------

/** Unique and readable production tag, e.g. prod-v4-20260924-1402. */
export function productionTag(version: number, now = new Date(), suffix = ""): string {
  const stamp = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "")
    .replace(/(\d{8})(\d{4})/, "$1-$2");
  return `prod-v${version}-${stamp}${suffix}`;
}

const promoteSteps: StepDefinition[] = [
  {
    key: "merge",
    label: "Version de production sur GitHub",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      if (release.gitTag) return { skipped: `tag ${release.gitTag} existant` };
      if (!ctx.site.gitRepo || !release.commitSha) {
        await prisma.release.update({
          where: { id: release.id },
          data: { gitTag: `local-v${release.version}` },
        });
        return { skipped: "pas de dépôt GitHub, version marquée localement" };
      }
      // The exact commit of this release, never whatever staging points to now.
      const res = await ctx.providers.git.promote({
        repo: ctx.site.gitRepo,
        tag: productionTag(release.version),
        commitSha: release.commitSha,
      });
      await prisma.release.update({ where: { id: release.id }, data: { gitTag: res.tag } });
      await ctx.log.success(`Branche production à jour, tag ${res.tag}`);
    },
  },
  {
    key: "deploy",
    label: "Mise en ligne sur le domaine",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      await deployRelease({
        site: ctx.site,
        server,
        release,
        environment: "production",
        providers: ctx.providers,
        settings: ctx.settings,
        log: ctx.log,
      });
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: { liveReleaseId: release.id, status: "live", lastPublishedAt: new Date() },
      });
      await ctx.refreshSite();
      await pruneOldReleases({
        site: ctx.site,
        server,
        environment: "production",
        keepReleaseIds: [release.id, ...(await productionKeepList(ctx.site.id))],
        providers: ctx.providers,
        log: ctx.log,
      });
    },
  },
  {
    key: "tls",
    label: "Certificat HTTPS",
    run: async (ctx) => {
      for (const host of productionHosts(ctx.site))
        await checkTls(host, ctx.site.id, ctx.providers, ctx.log);
    },
  },
  {
    key: "screenshot",
    label: "Capture d'écran",
    run: async (ctx) => {
      await captureScreenshot(ctx.site, "production", ctx.providers, ctx.settings, ctx.log);
      await ctx.log.success(`${ctx.site.domain} est en ligne.`);
    },
  },
];

export async function startPromote(siteId: string, releaseId: string, userId: string | null) {
  const deployment = await createExclusiveDeployment({
    siteId,
    kind: "promote",
    environment: "production",
    releaseId,
    userId,
  });
  await enqueue(QUEUES.promote, { deploymentId: deployment.id } satisfies DeployPayload, {
    singletonKey: deployment.id,
  });
  return deployment;
}

export async function runPromote(payload: DeployPayload) {
  await runPipeline(payload.deploymentId, promoteSteps);
}

// ---------- Rollback ----------

const rollbackSteps: StepDefinition[] = [
  {
    key: "switch",
    label: "Retour à la version précédente",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      // Instant when the release is still on the server; otherwise it is sent again.
      const switched = await runtimeFor(ctx.site.runtime).rollback(ctx.providers.agent, {
        server: serverRef(server),
        slug: ctx.site.slug,
        releaseId: release.id,
        log: (m) => ctx.log.info(m),
      });
      if (!switched) {
        await ctx.log.info("Version absente du serveur : nouvel envoi");
        await deployRelease({
          site: ctx.site,
          server,
          release,
          environment: "production",
          providers: ctx.providers,
          settings: ctx.settings,
          log: ctx.log,
        });
      }
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: { liveReleaseId: release.id, status: "live", lastPublishedAt: new Date() },
      });
      await ctx.log.success(`Version ${release.version} remise en ligne`);
      if (ctx.site.gitRepo && release.commitSha) {
        const res = await ctx.providers.git.promote({
          repo: ctx.site.gitRepo,
          tag: productionTag(release.version, new Date(), "-retour"),
          commitSha: release.commitSha,
        });
        await ctx.log.info(
          `Branche production replacée sur ${res.commitSha.slice(0, 7)} (tag ${res.tag})`,
        );
      }
    },
  },
  {
    key: "screenshot",
    label: "Capture d'écran",
    run: async (ctx) => {
      await captureScreenshot(ctx.site, "production", ctx.providers, ctx.settings, ctx.log);
    },
  },
];

export async function startRollback(
  siteId: string,
  releaseId: string,
  userId: string | null,
  rollbackOfId: string | null,
) {
  const deployment = await createExclusiveDeployment({
    siteId,
    kind: "rollback",
    environment: "production",
    releaseId,
    userId,
    rollbackOfId,
  });
  await enqueue(QUEUES.rollback, { deploymentId: deployment.id } satisfies DeployPayload, {
    singletonKey: deployment.id,
  });
  return deployment;
}

export async function runRollback(payload: DeployPayload) {
  await runPipeline(payload.deploymentId, rollbackSteps);
}

/**
 * Re-queues a failed deployment; the pipeline resumes at the failed step with
 * the confirmations recorded when it was started. `confirm` records a new admin
 * confirmation to order a server (the caller checks the role and audits it).
 */
export async function retryDeployment(
  deploymentId: string,
  confirm?: { serverOrderConfirmedById: string; serverOrderMaxPrice: number | null },
) {
  const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  if (d.status !== "failed") return d;
  const busy = await prisma.deployment.findFirst({
    where: { siteId: d.siteId, id: { not: d.id }, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (busy) throw new DeploymentBusyError();
  // Only one of two simultaneous clicks re-queues the deployment.
  const claimed = await prisma.deployment.updateMany({
    where: { id: d.id, status: "failed" },
    data: { status: "queued", error: null, ...(confirm ?? {}) },
  });
  if (claimed.count === 0) return d;
  const queue = {
    provision: QUEUES.provision,
    deploy: QUEUES.deploy,
    promote: QUEUES.promote,
    rollback: QUEUES.rollback,
  }[d.kind];
  if (d.kind === "provision")
    await prisma.site.update({ where: { id: d.siteId }, data: { status: "provisioning" } });
  await enqueue(queue, { deploymentId: d.id }, { singletonKey: `${d.id}:${Date.now()}` });
  return d;
}
