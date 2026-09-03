import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { auth } from "./auth";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("auth configuration", () => {
  it("trusts only the configured origin and throttles sign-in", () => {
    const options = auth.options as {
      trustedOrigins?: string[];
      rateLimit?: {
        storage?: string;
        customRules?: Record<string, { window: number; max: number }>;
      };
      emailAndPassword?: { disableSignUp?: boolean };
    };
    expect(options.trustedOrigins).toEqual([process.env.APP_URL]);
    expect(options.rateLimit?.storage).toBe("database");
    expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 300, max: 10 });
    expect(options.emailAndPassword?.disableSignUp).toBe(true);
  });
});

/**
 * The rate limit counters live in the database, and that path only runs outside
 * development: this test proves the table better-auth expects really exists.
 */
describe.skipIf(!hasDb)("rateLimit storage", () => {
  const key = `test:${Date.now()}`;

  afterAll(async () => {
    await prisma.rateLimit.deleteMany({ where: { key } });
  });

  it("stores a counter with the shape better-auth writes", async () => {
    await prisma.rateLimit.create({
      data: { id: key, key, count: 1, lastRequest: BigInt(Date.now()) },
    });
    const row = await prisma.rateLimit.findUniqueOrThrow({ where: { key } });
    expect(row.count).toBe(1);
    expect(typeof row.lastRequest).toBe("bigint");
  });
});
