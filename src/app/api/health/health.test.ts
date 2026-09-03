import { describe, expect, it } from "vitest";
import { GET } from "./route";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("GET /api/health", () => {
  it("reports the database as reachable", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", database: "ok" });
  });
});
