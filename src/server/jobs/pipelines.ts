import type { DeployEnv, DeployKind } from "@prisma/client";
import { prisma } from "../db";
import { previewHostFor } from "../settings";
import { enqueue, QUEUES } from "./boss";
import { runPipeline, type StepDefinition } from "./pipeline";
import { bootstrapServer, listCandidates, orderServer, serverRef } from "./steps/server";
import { configureDns, registerDomain } from "./steps/domain";
import {
  captureScreenshot,
  checkTls,
  deployRelease,
  localPreviewUrl,
  productionHosts,
} from "./steps/site";
import { pickServer } from "../capacity";

export type ProvisionPayload = {
  deploymentId: string;
  confirmServerOrder?: boolean;
  zipBytes?: number;
};
export type DeployPayload = { deploymentId: string };
export type ServerOrderPayload = { serverId?: string; offerId?: string };

async function createDeployment(
  siteId: string,
  kind: DeployKind,
  environment: DeployEnv | null,
  releaseId: string | null,
  userId: string | null,
  rollbackOfId?: string,
) {
  return prisma.deployment.create({
    data: { siteId, kind, environment, releaseId, triggeredById: userId, rollbackOfId },
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
        await bootstrapServer(s, ctx.providers, ctx.log);
        return;
      }
      const candidates = await listCandidates(ctx.providers.demo);
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
      if (!payload.confirmServerOrder) {
        throw new Error(
          "Aucun serveur n'a de place disponible. Un administrateur doit confirmer la commande d'un nouveau serveur.",
        );
      }
      await ctx.log.warn("Aucun serveur disponible : commande d'un nouveau serveur");
      let server = await orderServer(ctx.providers, ctx.settings, ctx.log);
      server = await bootstrapServer(server, ctx.providers, ctx.log);
      await prisma.site.update({ where: { id: ctx.site.id }, data: { serverId: server.id } });
      await ctx.refreshSite();
    },
  },
  {
    key: "domain",
    label: "Nom de domaine",
    run: async (ctx) => {
      const domain = await prisma.domain.findUnique({ where: { siteId: ctx.site.id } });
      if (!domain) throw new Error("Aucun domaine renseigné");
      if (domain.owned) return { skipped: `${domain.fqdn} est déjà dans le compte Gandi` };
      if (domain.orderStatus === "registered") return { skipped: "déjà enregistré" };
      await registerDomain(domain, ctx.providers, ctx.settings, ctx.log);
    },
  },
  {
    key: "dns",
    label: "DNS",
    run: async (ctx) => {
      const domain = await prisma.domain.findUniqueOrThrow({ where: { siteId: ctx.site.id } });
      const server = await prisma.server.findUniqueOrThrow({ where: { id: ctx.site.serverId! } });
      await configureDns(domain, ctx.site.slug, server, ctx.providers, ctx.settings, ctx.log);
      await prisma.site.update({
        where: { id: ctx.site.id },
        data: { previewHost: previewHostFor(ctx.site.slug, ctx.settings) },
      });
    },
  },
  {
    key: "repo",
    label: "Dépôt GitHub",
    run: async (ctx) => {
      if (ctx.site.gitRepo) return { skipped: `dépôt ${ctx.site.gitRepo} existant` };
      const repo = await ctx.providers.git.createRepo(ctx.site.slug);
      await ctx.log.success(`Dépôt privé ${repo.fullName} créé (${repo.url})`);
      await prisma.site.update({ where: { id: ctx.site.id }, data: { gitRepo: repo.fullName } });
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
      await prisma.site.update({ where: { id: ctx.site.id }, data: { status: "ready" } });
      await ctx.log.success("Infrastructure prête. Vous pouvez déposer le site.");
    },
  },
];

export async function startProvision(
  siteId: string,
  userId: string | null,
  opts: { confirmServerOrder: boolean; zipBytes?: number },
) {
  const existing = await prisma.deployment.findFirst({
    where: { siteId, kind: "provision", status: { in: ["queued", "running", "failed"] } },
    orderBy: { createdAt: "desc" },
  });
  const deployment = existing ?? (await createDeployment(siteId, "provision", null, null, userId));
  if (existing?.status === "failed") {
    await prisma.deployment.update({
      where: { id: existing.id },
      data: { status: "queued", error: null },
    });
  }
  await prisma.site.update({ where: { id: siteId }, data: { status: "provisioning" } });
  await enqueue(
    QUEUES.provision,
    { deploymentId: deployment.id, ...opts } satisfies ProvisionPayload,
    { singletonKey: deployment.id },
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
    label: "Envoi sur GitHub (staging)",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      if (release.commitSha)
        return { skipped: `commit ${release.commitSha.slice(0, 7)} déjà poussé` };
      if (!ctx.site.gitRepo) throw new Error("Dépôt GitHub absent");
      const { commitSha } = await ctx.providers.git.pushRelease({
        repo: ctx.site.gitRepo,
        releaseDir: `releases/${release.id}`,
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
          status: ctx.site.status === "live" ? "live" : "preview",
          previewHost: previewHostFor(ctx.site.slug, ctx.settings),
        },
      });
      await ctx.refreshSite();
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
      if (ctx.site.status === "live") return { skipped: "la capture de production est conservée" };
      await captureScreenshot(
        ctx.site,
        localPreviewUrl(ctx.deployment.releaseId!),
        ctx.providers,
        ctx.log,
      );
    },
  },
];

export async function startStagingDeploy(siteId: string, releaseId: string, userId: string | null) {
  const deployment = await createDeployment(siteId, "deploy", "staging", releaseId, userId);
  await enqueue(QUEUES.deploy, { deploymentId: deployment.id } satisfies DeployPayload, {
    singletonKey: deployment.id,
  });
  return deployment;
}

export async function runStagingDeploy(payload: DeployPayload) {
  await runPipeline(payload.deploymentId, stagingSteps);
}

// ---------- Promote (production) ----------

const promoteSteps: StepDefinition[] = [
  {
    key: "merge",
    label: "Fusion staging → production",
    run: async (ctx) => {
      const release = await prisma.release.findUniqueOrThrow({
        where: { id: ctx.deployment.releaseId! },
      });
      if (release.gitTag) return { skipped: `tag ${release.gitTag} existant` };
      if (!ctx.site.gitRepo) throw new Error("Dépôt GitHub absent");
      const tag = `prod-${new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[-:T]/g, "")
        .replace(/(\d{8})(\d{4})/, "$1-$2")}`;
      const res = await ctx.providers.git.promote({ repo: ctx.site.gitRepo, tag });
      await prisma.release.update({
        where: { id: release.id },
        data: { gitTag: res.tag, commitSha: release.commitSha ?? res.commitSha },
      });
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
      await captureScreenshot(
        ctx.site,
        localPreviewUrl(ctx.deployment.releaseId!),
        ctx.providers,
        ctx.log,
      );
      await ctx.log.success(`${ctx.site.domain} est en ligne.`);
    },
  },
];

export async function startPromote(siteId: string, releaseId: string, userId: string | null) {
  const deployment = await createDeployment(siteId, "promote", "production", releaseId, userId);
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
      await ctx.log.success(`Version ${release.version} remise en ligne`);
    },
  },
  {
    key: "screenshot",
    label: "Capture d'écran",
    run: async (ctx) => {
      await captureScreenshot(
        ctx.site,
        localPreviewUrl(ctx.deployment.releaseId!),
        ctx.providers,
        ctx.log,
      );
    },
  },
];

export async function startRollback(
  siteId: string,
  releaseId: string,
  userId: string | null,
  rollbackOfId: string,
) {
  const deployment = await createDeployment(
    siteId,
    "rollback",
    "production",
    releaseId,
    userId,
    rollbackOfId,
  );
  await enqueue(QUEUES.rollback, { deploymentId: deployment.id } satisfies DeployPayload, {
    singletonKey: deployment.id,
  });
  return deployment;
}

export async function runRollback(payload: DeployPayload) {
  await runPipeline(payload.deploymentId, rollbackSteps);
}

/** Re-sends a failed deployment to its queue; the pipeline resumes at the failed step. */
export async function retryDeployment(deploymentId: string) {
  const d = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  if (d.status !== "failed") return d;
  await prisma.deployment.update({ where: { id: d.id }, data: { status: "queued", error: null } });
  const queue = {
    provision: QUEUES.provision,
    deploy: QUEUES.deploy,
    promote: QUEUES.promote,
    rollback: QUEUES.rollback,
  }[d.kind];
  if (d.kind === "provision")
    await prisma.site.update({ where: { id: d.siteId }, data: { status: "provisioning" } });
  await enqueue(
    queue,
    { deploymentId: d.id, confirmServerOrder: true },
    { singletonKey: `${d.id}:${Date.now()}` },
  );
  return d;
}
