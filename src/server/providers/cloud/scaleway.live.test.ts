/** Optional read-only check against Scaleway. Enabled by TEST_SCALEWAY_SECRET_KEY and TEST_SCALEWAY_PROJECT_ID. Never creates anything. */
import { describe, expect, it } from "vitest";
import { ScalewayProvider } from "./scaleway";

const key = process.env.TEST_SCALEWAY_SECRET_KEY;
const project = process.env.TEST_SCALEWAY_PROJECT_ID;

describe.skipIf(!key || !project)("Scaleway live (read-only)", () => {
  const p = new ScalewayProvider({ secretKey: key!, projectId: project! });
  it("lists offers and identifies the project", async () => {
    const offers = await p.listOffers(process.env.TEST_SCALEWAY_ZONE ?? "fr-par-1");
    // DEV1 may be at end of service: any orderable offer will do.
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) expect(o.monthlyPrice).toBeGreaterThan(0);
    const me = await p.whoAmI("fr-par-1");
    expect(me.offers).toBeGreaterThan(0);
    expect(await p.findServerByName(`auscii-live-test-${Date.now()}`, "fr-par-1")).toBeNull();
  });
});
