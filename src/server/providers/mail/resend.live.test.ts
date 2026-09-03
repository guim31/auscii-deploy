/** Optional read-only check against Resend. Enabled by TEST_RESEND_API_KEY. */
import { describe, expect, it } from "vitest";
import { ResendProvider } from "./resend";

const apiKey = process.env.TEST_RESEND_API_KEY;

describe.skipIf(!apiKey)("Resend live (read-only)", () => {
  it("lists the account domains", async () => {
    const me = await new ResendProvider({ apiKey: apiKey! }).whoAmI();
    expect(Array.isArray(me.domains)).toBe(true);
  });
});
