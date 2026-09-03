import type { PgBoss, Job } from "pg-boss";
import { QUEUES } from "./boss";
import { PipelineError } from "./pipeline";
import {
  runProvision,
  runPromote,
  runRollback,
  runStagingDeploy,
  type DeployPayload,
  type ProvisionPayload,
} from "./pipelines";
import { checkAllCertificates, collectAllMetrics, orderStandaloneServer } from "./maintenance";
import { refreshAllDomains } from "./domain-refresh";
import { generateAiReport, type AiReportPayload } from "./ai-report";
import { runServerBootstrap, type ServerBootstrapPayload } from "./steps/register-server";
import { runServerDelete, type ServerDeletePayload } from "./steps/delete-server";
import { runMailSend, type MailSendPayload } from "./mail";

const workOptions = { batchSize: 1, pollingIntervalSeconds: 1 } as const;

function one<T>(jobs: Job<T>[]): T {
  return jobs[0].data;
}

/** A pipeline failure is already recorded on the Deployment; the job itself completes. */
async function handled(run: Promise<void>): Promise<void> {
  try {
    await run;
  } catch (err) {
    if (err instanceof PipelineError) return;
    throw err;
  }
}

/** Registers every queue handler on the given pg-boss instance. Used by the worker process. */
export async function registerHandlers(boss: PgBoss): Promise<void> {
  await boss.work<ProvisionPayload>(QUEUES.provision, workOptions, async (jobs) =>
    handled(runProvision(one(jobs))),
  );
  await boss.work<DeployPayload>(QUEUES.deploy, workOptions, async (jobs) =>
    handled(runStagingDeploy(one(jobs))),
  );
  await boss.work<DeployPayload>(QUEUES.promote, workOptions, async (jobs) =>
    handled(runPromote(one(jobs))),
  );
  await boss.work<DeployPayload>(QUEUES.rollback, workOptions, async (jobs) =>
    handled(runRollback(one(jobs))),
  );
  await boss.work<AiReportPayload>(QUEUES.aiReport, workOptions, async (jobs) =>
    generateAiReport(one(jobs)),
  );
  await boss.work<{ offerId?: string }>(QUEUES.serverOrder, workOptions, async (jobs) => {
    await orderStandaloneServer(one(jobs).offerId);
  });
  await boss.work<ServerBootstrapPayload>(QUEUES.serverBootstrap, workOptions, async (jobs) =>
    runServerBootstrap(one(jobs)),
  );
  await boss.work<ServerDeletePayload>(QUEUES.serverDelete, workOptions, async (jobs) =>
    runServerDelete(one(jobs)),
  );
  await boss.work<MailSendPayload>(QUEUES.mailSend, workOptions, async (jobs) =>
    runMailSend(one(jobs)),
  );
  await boss.work(QUEUES.serverHealth, { ...workOptions, pollingIntervalSeconds: 10 }, async () => {
    await collectAllMetrics();
  });
  await boss.work(QUEUES.sslCheck, { ...workOptions, pollingIntervalSeconds: 10 }, async () => {
    await checkAllCertificates();
  });
  await boss.work(
    QUEUES.domainRefresh,
    { ...workOptions, pollingIntervalSeconds: 10 },
    async () => {
      await refreshAllDomains();
    },
  );
  await boss.schedule(QUEUES.domainRefresh, "0 7 * * *");
  await boss.schedule(QUEUES.serverHealth, "0 * * * *");
  await boss.schedule(QUEUES.sslCheck, "30 6 * * *");
}
