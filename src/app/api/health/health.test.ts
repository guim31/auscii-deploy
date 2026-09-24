import { afterEach, describe, expect, it, vi } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.skipIf(!hasDb)("GET /api/health", () => {
  it("reports the database as reachable", async () => {
    const { GET } = await loadRoute();
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", database: "ok" });
  });
});

describe("GET /api/health with a refused configuration", () => {
  it("answers 503 without leaking the reason", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.invalid:5432/auscii");
    vi.stubEnv("APP_URL", "https://deploy.example.fr");
    vi.stubEnv("BETTER_AUTH_SECRET", "change-me-change-me-change-me");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadRoute();
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "error", config: "invalid" });
    expect(JSON.stringify(body)).not.toMatch(/BETTER_AUTH_SECRET/);
    expect(String(logged.mock.calls[0]?.[1])).toMatch(/BETTER_AUTH_SECRET/);
  });
});
