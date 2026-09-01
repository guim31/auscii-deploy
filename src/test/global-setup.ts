import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

/** Applies migrations to the test database before the suite runs. */
export default function setup() {
  loadEnv();
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (!url) {
    console.warn("[test] DATABASE_URL absent : les tests base de données seront ignorés");
    return;
  }
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
