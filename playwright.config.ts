import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// ADMIN_EMAIL / ADMIN_PASSWORD of the seeded account come from .env locally.
loadEnv({ quiet: true });

const port = Number(process.env.E2E_PORT ?? 3100);

/**
 * Two ways to serve the app:
 * - production build (`next start`, after `pnpm build`): always in CI, and
 *   locally with `pnpm e2e:build` — this is what ships;
 * - `next dev` otherwise, for a quick local loop.
 */
const useBuild = Boolean(process.env.CI) || process.env.E2E_BUILD === "1";
const webCommand = useBuild ? `next start -p ${port}` : `next dev -p ${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "fr-FR",
    screenshot: "only-on-failure",
    trace: process.env.CI ? "retain-on-failure" : "off",
    // Lets an environment reuse a preinstalled Chromium instead of downloading one.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  // The app and the worker both run: deployments are processed by the worker.
  webServer: {
    command: `pnpm exec concurrently -k "${webCommand}" "tsx src/worker/index.ts"`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DEMO_MODE: "true",
      APP_URL: `http://localhost:${port}`,
      PREVIEW_ORIGIN: "",
      MOCK_SPEED: "0.3",
    },
  },
});
