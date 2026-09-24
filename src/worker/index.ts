import { config as loadEnv } from "dotenv";
loadEnv();

import { startBoss } from "../server/jobs/boss";
import { registerHandlers } from "../server/jobs/handlers";
import { failInterruptedDeployments } from "../server/jobs/pipeline";

async function main() {
  const boss = await startBoss("worker");
  // Nothing runs yet: a deployment still "running" was cut by the previous stop.
  const interrupted = await failInterruptedDeployments();
  if (interrupted > 0)
    console.warn(`[worker] ${interrupted} déploiement(s) interrompu(s) marqué(s) en échec`);
  await registerHandlers(boss);
  console.log("[worker] prêt, en attente de jobs");

  const shutdown = async () => {
    console.log("[worker] arrêt…");
    await boss.stop({ graceful: true, timeout: 20_000 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] erreur fatale", err);
  process.exit(1);
});
