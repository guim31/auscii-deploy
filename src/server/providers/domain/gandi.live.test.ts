/** Optional read-only check against the real Gandi API. Enabled by TEST_GANDI_TOKEN. Never buys anything. */
import { describe, expect, it } from "vitest";
import { GandiProvider } from "./gandi";

const token = process.env.TEST_GANDI_TOKEN;

describe.skipIf(!token)("Gandi live (read-only)", () => {
  const p = new GandiProvider({ apiKey: token!, organizationId: process.env.TEST_GANDI_ORG });

  it("identifies the account", async () => {
    const me = await p.whoAmI();
    expect(me.user).toBeTruthy();
  });

  it("checks a taken and a free domain", async () => {
    expect((await p.check("google.fr")).available).toBe(false);
    const free = await p.check(`auscii-test-${Date.now().toString(36)}.fr`);
    expect(free.available).toBe(true);
    expect(free.price).toBeGreaterThan(0);
  });

  it("lists owned domains and reads one", async () => {
    const owned = await p.listOwned();
    expect(Array.isArray(owned)).toBe(true);
    if (owned[0]) {
      const d = await p.getDomain(owned[0]);
      expect(d?.fqdn).toBe(owned[0]);
      expect(["active", "pending", "other"]).toContain(d?.status);
    }
    expect(await p.getDomain(`auscii-test-${Date.now().toString(36)}.fr`)).toBeNull();
  });
});
