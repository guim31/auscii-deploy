import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv();

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "";

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
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      APP_ENCRYPTION_KEY: "7f3b2c1d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
