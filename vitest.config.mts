import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ quiet: true });

/**
 * Database tests delete and reseed demo data: they only ever run against
 * DATABASE_URL_TEST, never against DATABASE_URL (the development database).
 * DATABASE_URL set without DATABASE_URL_TEST is refused; with neither, the
 * database suites are skipped.
 */
function testDatabaseUrl(): string {
  const testUrl = process.env.DATABASE_URL_TEST ?? "";
  const devUrl = process.env.DATABASE_URL ?? "";
  if (!testUrl) {
    if (devUrl) {
      throw new Error(
        "DATABASE_URL_TEST absent : les tests ne tournent jamais sur DATABASE_URL (base de " +
          "développement, dont ils effacent les données de démo). Définissez une base dédiée, " +
          "ex. DATABASE_URL_TEST=postgresql://auscii:auscii@localhost:5432/auscii_test.",
      );
    }
    console.warn("[test] aucune base configurée : les tests base de données sont ignorés.");
    return "";
  }
  if (devUrl && sameDatabase(testUrl, devUrl)) {
    throw new Error(
      "DATABASE_URL_TEST désigne la même base que DATABASE_URL : les tests effaceraient " +
        "les données de développement. Utilisez une base dédiée (ex. auscii_test).",
    );
  }
  return testUrl;
}

function sameDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const port = (u: URL) => u.port || "5432";
    return ua.hostname === ub.hostname && port(ua) === port(ub) && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

const databaseUrl = testDatabaseUrl();

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/test/global-setup.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DEMO_MODE: "true",
      DATABASE_URL: databaseUrl,
      DATA_DIR: "./data-test",
      APP_URL: "http://localhost:3000",
      PREVIEW_ORIGIN: "",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      APP_ENCRYPTION_KEY: "7f3b2c1d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
