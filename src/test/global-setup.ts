import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Applies migrations to the test database before the suite runs. Only
 * DATABASE_URL_TEST is used (vitest.config.mts refuses it when it designates
 * the development database); Prisma creates the database if it is missing.
 */
export default function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) return;
  execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } },
  );
}
