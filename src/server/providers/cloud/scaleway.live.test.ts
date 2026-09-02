/** Optional read-only check against Scaleway. Enabled by TEST_SCALEWAY_SECRET_KEY and TEST_SCALEWAY_PROJECT_ID. Never creates anything. */
import { describe, expect, it } from "vitest";
import { ScalewayProvider } from "./scaleway";

const key = process.env.TEST_SCALEWAY_SECRET_KEY;
const project = process.env.TEST_SCALEWAY_PROJECT_ID;

describe.skipIf(!key || !project)("Scaleway live (read-only)", () => {
  const p = new ScalewayProvider({ secretKey: key!, projectId: project! });
  it("lists offers and identifies the project", async () => {
    const offers = await p.listOffers(process.env.TEST_SCALEWAY_ZONE ?? "fr-par-1");
    expect(offers.some((o) => o.id === "DEV1-S")).toBe(true);
    const me = await p.whoAmI("fr-par-1");
    expect(me.offers).toBeGreaterThan(0);
  });
});
