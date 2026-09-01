import { defineConfig } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "fr-FR",
    screenshot: "only-on-failure",
    // Lets an environment reuse a preinstalled Chromium instead of downloading one.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  // The app and the worker both run: deployments are processed by the worker.
  webServer: {
    command: `pnpm exec concurrently -k "next dev -p ${port}" "tsx src/worker/index.ts"`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { DEMO_MODE: "true", APP_URL: `http://localhost:${port}`, MOCK_SPEED: "0.3" },
  },
});
