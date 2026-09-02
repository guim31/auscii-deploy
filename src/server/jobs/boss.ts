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
  serverHealth: "server.health",
  sslCheck: "ssl.check",
  domainRefresh: "domain.refresh",
  aiReport: "release.aiReport",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const globalForBoss = globalThis as unknown as { boss?: PgBoss; bossStarted?: Promise<PgBoss> };

export function getBoss(): PgBoss {
  if (!globalForBoss.boss) {
    globalForBoss.boss = new PgBoss({
      connectionString: env().DATABASE_URL,
      schema: "pgboss",
      max: 4,
    });
    globalForBoss.boss.on("error", (err: Error) => console.error("[pg-boss]", err));
  }
  return globalForBoss.boss;
}

/** Starts pg-boss once per process and makes sure every queue exists. */
export function startBoss(): Promise<PgBoss> {
  if (!globalForBoss.bossStarted) {
    globalForBoss.bossStarted = (async () => {
      const boss = getBoss();
      await boss.start();
      for (const name of Object.values(QUEUES)) {
        // Retries only cover jobs lost to a worker restart or a timeout: pipelines
        // report their own failures without throwing, so a handled failure is not retried.
        const options = {
          retryLimit: 2,
          retryDelay: 30,
          retryBackoff: true,
          expireInSeconds: 60 * 15,
          retentionSeconds: 60 * 60 * 24 * 7,
        };
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
