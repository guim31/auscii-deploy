import { describe, expect, it } from "vitest";
import { productionIssues, type Env } from "./env";

const base: Env = {
  DATABASE_URL: "postgresql://u:p@db:5432/auscii",
  APP_URL: "https://deploy.auscii.site",
  BETTER_AUTH_SECRET: "6f1c2f2a4a2c4f6e8b0d2f4a6c8e0b2d",
  APP_ENCRYPTION_KEY: "7f3b2c1d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c",
  DATA_DIR: "/data",
  DEMO_MODE: false,
  NODE_ENV: "production",
};

describe("productionIssues", () => {
  it("accepts a properly configured pilot", () => {
    expect(productionIssues(base)).toEqual([]);
  });

  it("ignores local development entirely", () => {
    const local = {
      ...base,
      APP_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "change-me-change-me-change-me-change-me",
      APP_ENCRYPTION_KEY: "0".repeat(64),
    };
    expect(productionIssues(local)).toEqual([]);
    expect(productionIssues({ ...local, APP_URL: "http://127.0.0.1:3100" })).toEqual([]);
  });

  it("refuses the example secrets on a public host", () => {
    const issues = productionIssues({
      ...base,
      BETTER_AUTH_SECRET: "change-me-change-me-change-me-change-me",
      APP_ENCRYPTION_KEY: "0".repeat(64),
    });
    expect(issues).toHaveLength(2);
    expect(issues.join(" ")).toContain("BETTER_AUTH_SECRET");
    expect(issues.join(" ")).toContain("APP_ENCRYPTION_KEY");
  });

  it("refuses plain HTTP on a public host", () => {
    const issues = productionIssues({ ...base, APP_URL: "http://deploy.auscii.site" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("https");
  });
});
