import type { Deployment, DeployKind, Prisma, Site, SiteStatus } from "@prisma/client";
import { prisma } from "../db";
import { getProviders, type Providers } from "../providers";
import { getSettings, type Settings } from "../settings";
import { createLogger, redactSecrets, type Logger } from "./log";
import { raiseAlert } from "./alerts";
import { env } from "../env";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export type StepState = {
  key: string;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
};

export type StepContext = {
  deployment: Deployment;
  site: Site;
  providers: Providers;
  settings: Settings;
  log: Logger;
  data: Record<string, unknown>;
  /** Reloads the site row, useful after a step updated it. */
  refreshSite: () => Promise<Site>;
};

export type StepDefinition = {
  key: string;
  label: string;
  /** Return "skipped" with a detail to record that the step was not needed. */
  run: (ctx: StepContext) => Promise<void | { skipped: string }>;
};

const KIND_LABEL: Record<string, string> = {
  provision: "infrastructure",
  deploy: "préproduction",
  promote: "mise en production",
  rollback: "retour arrière",
};

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly step: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

function stepsFromJson(json: Prisma.JsonValue, defs: StepDefinition[]): StepState[] {
  const existing = Array.isArray(json) ? (json as StepState[]) : [];
  return defs.map(
    (d) =>
      existing.find((s) => s.key === d.key) ?? { key: d.key, label: d.label, status: "pending" },
  );
}

/**
 * Status of a site after a failed deployment. A site in production stays in
 * production: a failed preproduction deploy, publication or rollback never
 * takes it out of "live" (its server stays protected, its certificate checked,
 * its rollback available). Only a failed provision puts a site in "error".
 */
export function statusAfterFailure(
  site: Pick<Site, "status" | "liveReleaseId">,
  kind: DeployKind,
): SiteStatus {
  if (site.liveReleaseId) return "live";
  if (kind === "provision") return "error";
  if (site.status === "draft" || site.status === "provisioning") return "error";
  return site.status;
}

async function failDeployment(input: {
  deployment: Deployment;
  site: Site;
  message: string;
  stepLabel?: string;
  steps?: StepState[];
}) {
  const { deployment, site, stepLabel, steps } = input;
  const message = redactSecrets(input.message);
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      status: "failed",
      error: message,
      finishedAt: new Date(),
      ...(steps ? { steps: steps as object } : {}),
    },
  });
  const current = await prisma.site.findUnique({ where: { id: site.id } });
  if (current) {
    await prisma.site.update({
      where: { id: site.id },
      data: { status: statusAfterFailure(current, deployment.kind) },
    });
  }
  await raiseAlert({
    kind: "deployment_failed",
    key: deployment.id,
    subject: `Déploiement en erreur : ${site.clientName}`,
    body: [
      `Le déploiement « ${KIND_LABEL[deployment.kind] ?? deployment.kind} » du site ${site.clientName} a échoué${stepLabel ? ` à l'étape « ${stepLabel} »` : ""}.`,
      "",
      `Erreur : ${message}`,
      "",
      `Détails et relance : ${env().APP_URL}/sites/${site.id}?deployment=${deployment.id}`,
    ].join("\n"),
    isDemo: site.isDemo,
  }).catch((err) => console.error("[alerts]", err instanceof Error ? err.message : err));
}

/**
 * Runs the steps of a deployment in order, persisting the state of each one.
 * Steps already "done" or "skipped" are not run again, so re-queuing the same
 * deployment resumes after a failure.
 *
 * The deployment is claimed atomically (queued → running): a duplicate job, or
 * a job re-delivered while the first run is still going, does nothing. Any
 * failure, inside a step or not, marks the deployment failed.
 */
export async function runPipeline(
  deploymentId: string,
  defs: StepDefinition[],
  data: Record<string, unknown> = {},
): Promise<void> {
  const claimed = await prisma.deployment.updateMany({
    where: { id: deploymentId, status: "queued" },
    data: { status: "running", error: null },
  });
  if (claimed.count === 0) {
    console.warn(`[pipeline] ${deploymentId} n'est pas en attente : exécution ignorée`);
    return;
  }
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  let site = await prisma.site.findUniqueOrThrow({ where: { id: deployment.siteId } });
  const steps = stepsFromJson(deployment.steps, defs);

  let providers: Providers;
  let settings: Settings;
  try {
    // The site decides between mocks and real integrations, never the current UI mode.
    providers = await getProviders({ demo: site.isDemo });
    settings = await getSettings();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { startedAt: deployment.startedAt ?? new Date(), steps: steps as object },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failDeployment({ deployment, site, message, steps });
    throw new PipelineError(message, "init");
  }

  const log = createLogger(deploymentId);
  const persist = () =>
    prisma.deployment.update({ where: { id: deploymentId }, data: { steps: steps as object } });

  const ctx: StepContext = {
    deployment,
    site,
    providers,
    settings,
    log,
    data,
    refreshSite: async () => {
      site = await prisma.site.findUniqueOrThrow({ where: { id: deployment.siteId } });
      ctx.site = site;
      return site;
    },
  };

  for (const def of defs) {
    const state = steps.find((s) => s.key === def.key)!;
    if (state.status === "done" || state.status === "skipped") continue;
    const stepLog = createLogger(deploymentId, def.key);
    try {
      state.status = "running";
      state.startedAt = new Date().toISOString();
      state.detail = undefined;
      await persist();
      ctx.log = stepLog;
      const result = await def.run(ctx);
      if (result && "skipped" in result) {
        state.status = "skipped";
        state.detail = result.skipped;
        await stepLog.info(`Ignoré : ${result.skipped}`);
      } else {
        state.status = "done";
      }
      state.finishedAt = new Date().toISOString();
      await persist();
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      state.status = "failed";
      state.detail = message;
      state.finishedAt = new Date().toISOString();
      await stepLog.error(message).catch(() => undefined);
      await failDeployment({ deployment, site, message, stepLabel: def.label, steps });
      throw new PipelineError(message, def.key);
    }
  }

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "succeeded", finishedAt: new Date(), steps: steps as object },
  });
}

const INTERRUPTED =
  "Interrompu : le worker a redémarré pendant l'exécution. Relancez : les étapes terminées ne seront pas refaites.";

/**
 * Marks as failed the deployments left "running" by a stopped worker (at
 * worker start: nothing can be running yet), or running for too long.
 */
export async function failInterruptedDeployments(olderThanMs = 0): Promise<number> {
  const stale = await prisma.deployment.findMany({
    where: {
      status: "running",
      ...(olderThanMs > 0 ? { startedAt: { lt: new Date(Date.now() - olderThanMs) } } : {}),
    },
    include: { site: true },
  });
  for (const d of stale) {
    const steps = (Array.isArray(d.steps) ? d.steps : []) as StepState[];
    for (const s of steps) if (s.status === "running") s.status = "failed";
    await failDeployment({ deployment: d, site: d.site, message: INTERRUPTED, steps });
  }
  return stale.length;
}
