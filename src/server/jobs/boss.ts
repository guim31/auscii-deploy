import { PgBoss, type SendOptions } from "pg-boss";
import { env } from "../env";

/**
 * Queue names. One pg-boss job runs one whole pipeline; the pipeline records
 * its own step progress in Deployment.steps so a re-run resumes where it stopped.
 */
export const QUEUES = {
  provision: "site.provision",
  deploy: "site.deploy",
  promote: "site.promote",
  rollback: "site.rollback",
  serverOrder: "server.order",
  serverBootstrap: "server.bootstrap",
  serverDelete: "server.delete",
  serverHealth: "server.health",
  sslCheck: "ssl.check",
  domainRefresh: "domain.refresh",
  aiReport: "release.aiReport",
  mailSend: "mail.send",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const globalForBoss = globalThis as unknown as { boss?: PgBoss; bossStarted?: Promise<PgBoss> };

/** Pipelines report their own failures and resume step by step: pg-boss never replays them. */
const PIPELINE_QUEUES: QueueName[] = [
  QUEUES.provision,
  QUEUES.deploy,
  QUEUES.promote,
  QUEUES.rollback,
  // Ordering a server is paid: never retried automatically.
  QUEUES.serverOrder,
];

function queueOptions(name: QueueName) {
  const base = {
    retryBackoff: true,
    // Completed jobs are kept a week for troubleshooting.
    deleteAfterSeconds: 60 * 60 * 24 * 7,
  };
  if (PIPELINE_QUEUES.includes(name)) {
    return {
      ...base,
      retryLimit: 0,
      // A provision may wait for a domain and a new server: well above the longest run.
      expireInSeconds: 60 * 60 * 3,
      // A crashed worker stops sending heartbeats: its job fails within minutes instead of
      // hours, and the deployment is marked failed at the next worker start.
      heartbeatSeconds: 60,
    };
  }
  if (name === QUEUES.mailSend) {
    // An email outage is absorbed over about a day (1 min, 2, 4… capped at 1 h).
    return {
      ...base,
      retryLimit: 12,
      retryDelay: 60,
      retryDelayMax: 60 * 60,
      expireInSeconds: 120,
    };
  }
  return { ...base, retryLimit: 2, retryDelay: 30, expireInSeconds: 60 * 15 };
}

/**
 * pg-boss instance of this process. Only the worker supervises queues and runs
 * the cron schedules; the web app just sends jobs.
 */
export function getBoss(role: "worker" | "app" = "app"): PgBoss {
  if (!globalForBoss.boss) {
    globalForBoss.boss = new PgBoss({
      connectionString: env().DATABASE_URL,
      schema: "pgboss",
      max: 4,
      supervise: role === "worker",
      schedule: role === "worker",
    });
    globalForBoss.boss.on("error", (err: Error) => console.error("[pg-boss]", err));
  }
  return globalForBoss.boss;
}

/** Starts pg-boss once per process and makes sure every queue exists with its options. */
export function startBoss(role: "worker" | "app" = "app"): Promise<PgBoss> {
  if (!globalForBoss.bossStarted) {
    globalForBoss.bossStarted = (async () => {
      const boss = getBoss(role);
      await boss.start();
      for (const name of Object.values(QUEUES)) {
        const options = queueOptions(name);
        await boss.createQueue(name, options);
        await boss.updateQueue(name, options);
      }
      return boss;
    })();
  }
  return globalForBoss.bossStarted;
}

export async function enqueue(
  name: QueueName,
  data: object,
  options?: SendOptions,
): Promise<string | null> {
  const boss = await startBoss();
  return boss.send(name, data, options);
}
