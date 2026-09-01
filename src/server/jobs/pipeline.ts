import type { Deployment, Prisma, Site } from "@prisma/client";
import { prisma } from "../db";
import { getProviders, type Providers } from "../providers";
import { getSettings, type Settings } from "../settings";
import { createLogger, type Logger } from "./log";

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
 * Runs the steps of a deployment in order, persisting the state of each one.
 * Steps already "done" or "skipped" are not run again, so re-sending the same
 * job resumes after a failure.
 */
export async function runPipeline(
  deploymentId: string,
  defs: StepDefinition[],
  data: Record<string, unknown> = {},
): Promise<void> {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!deployment) throw new Error(`Deployment ${deploymentId} introuvable`);
  if (deployment.status === "succeeded") return;

  let site = await prisma.site.findUniqueOrThrow({ where: { id: deployment.siteId } });
  const providers = await getProviders();
  const settings = await getSettings();
  const steps = stepsFromJson(deployment.steps, defs);
  const log = createLogger(deploymentId);

  const persist = () =>
    prisma.deployment.update({ where: { id: deploymentId }, data: { steps: steps as object } });

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: "running",
      startedAt: deployment.startedAt ?? new Date(),
      error: null,
      steps: steps as object,
    },
  });

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
    state.status = "running";
    state.startedAt = new Date().toISOString();
    state.detail = undefined;
    await persist();
    const stepLog = createLogger(deploymentId, def.key);
    ctx.log = stepLog;
    try {
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
      const message = err instanceof Error ? err.message : String(err);
      state.status = "failed";
      state.detail = message;
      state.finishedAt = new Date().toISOString();
      await stepLog.error(message);
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "failed", error: message, finishedAt: new Date(), steps: steps as object },
      });
      await prisma.site.update({ where: { id: site.id }, data: { status: "error" } });
      throw new PipelineError(message, def.key);
    }
  }

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "succeeded", finishedAt: new Date(), steps: steps as object },
  });
}
