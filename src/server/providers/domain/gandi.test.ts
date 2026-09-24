import { describe, expect, it } from "vitest";
import {
  availabilityFromCheck,
  domainStatusFrom,
  GandiProvider,
  missingContactFields,
  normalizeGandiPhone,
  orderFromDomainInfo,
  orderIdFor,
  quoteTxtValue,
  toGandiOwner,
} from "./gandi";
import { describeGandiError, GandiError } from "./gandi-client";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Route = (
  call: Call,
  n: number,
) => { status: number; body?: unknown; headers?: Record<string, string> };

/** Routes match by substring of "METHOD URL", first declared wins: declare specific paths first. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.includes(k));
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    counts[key] = (counts[key] ?? 0) + 1;
    const r = routes[key](call, counts[key]);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  };
  return { impl, calls };
}

const API = "https://api.gandi.net/v5";

const CONTACT = {
  email: "contact@auscii.com",
  orgName: "AUSCII",
  givenName: "Guilhem",
  familyName: "Henry",
  phone: "+33.612345678",
  street: "1 rue de la Paix",
  zip: "31000",
  city: "Toulouse",
  country: "fr",
};

const CHECK_AVAILABLE = {
  currency: "EUR",
  products: [
    {
      name: "boulangerie-dupont.fr",
      status: "available",
      process: "create",
      prices: [
        {
          duration_unit: "y",
          min_duration: 1,
          max_duration: 10,
          price_after_taxes: 15.6,
          price_before_taxes: 13,
        },
      ],
    },
  ],
};
const CHECK_TAKEN = {
  currency: "EUR",
  products: [{ name: "google.fr", status: "unavailable", process: "create" }],
};
const CHECK_PREMIUM = {
  currency: "EUR",
  products: [
    {
      name: "paris.fr",
      status: "available_premium",
      process: "create",
      prices: [{ price_after_taxes: 1200, price_before_taxes: 1000 }],
    },
  ],
};

/** Check route that ignores the best-effort renewal lookup. */
function checkRoute(body: unknown): Route {
  return (c) =>
    c.url.includes("processes=renew") ? { status: 400, body: {} } : { status: 200, body };
}

describe("availabilityFromCheck", () => {
  it("reads price and availability", () => {
    const a = availabilityFromCheck("boulangerie-dupont.fr", CHECK_AVAILABLE);
    expect(a).toMatchObject({
      available: true,
      price: 15.6,
      priceBeforeTaxes: 13,
      currency: "EUR",
      premium: false,
    });
    expect(a.renewPrice).toBeUndefined();
  });
  it("handles taken, premium and unsupported names", () => {
    expect(availabilityFromCheck("google.fr", CHECK_TAKEN).available).toBe(false);
    expect(
      availabilityFromCheck("x.fr", {
        products: [
          { name: "x.fr", status: "available_premium", prices: [{ price_after_taxes: 999 }] },
        ],
      }),
    ).toMatchObject({ available: true, premium: true, price: 999 });
    expect(availabilityFromCheck("x.zz", { products: [] }).reason).toMatch(/Extension/);
  });
  it("exposes the renewal price when the first year is a promotion", () => {
    const promo = availabilityFromCheck("a.com", {
      currency: "EUR",
      products: [
        {
          name: "a.com",
          status: "available",
          process: "create",
          prices: [{ price_after_taxes: 4.8, discount: true, normal_price_after_taxes: 18 }],
        },
      ],
    });
    expect(promo).toMatchObject({ price: 4.8, renewPrice: 18 });
    const withRenew = availabilityFromCheck("a.com", {
      products: [
        {
          name: "a.com",
          status: "available",
          process: "create",
          prices: [{ price_after_taxes: 4.8 }],
        },
        {
          name: "a.com",
          status: "available",
          process: "renew",
          prices: [{ price_after_taxes: 21 }],
        },
      ],
    });
    expect(withRenew).toMatchObject({ price: 4.8, renewPrice: 21 });
  });
});

describe("contact mapping", () => {
  it("maps the agency to a company owner", () => {
    expect(toGandiOwner(CONTACT)).toMatchObject({
      type: 1,
      orgname: "AUSCII",
      country: "FR",
      given: "Guilhem",
      phone: "+33.612345678",
    });
    expect(missingContactFields(CONTACT)).toEqual([]);
    expect(missingContactFields({ email: "a@b.c" })).toContain("téléphone");
  });

  it("normalises the phone and passes the SIREN of a company", () => {
    const owner = toGandiOwner({ ...CONTACT, phone: "06 12 34 56 78", siren: "123 456 789" });
    expect(owner.phone).toBe("+33.612345678");
    expect(owner).toMatchObject({ siren: "123456789" });
    expect(toGandiOwner({ ...CONTACT, orgName: undefined, siren: "123456789" })).not.toHaveProperty(
      "siren",
    );
  });

  it("normalizeGandiPhone understands the usual French forms", () => {
    expect(normalizeGandiPhone("+33.612345678")).toBe("+33.612345678");
    expect(normalizeGandiPhone("06 12 34 56 78")).toBe("+33.612345678");
    expect(normalizeGandiPhone("06.12.34.56.78")).toBe("+33.612345678");
    expect(normalizeGandiPhone("+33 6 12 34 56 78")).toBe("+33.612345678");
    expect(normalizeGandiPhone("+33 (0)6 12 34 56 78")).toBe("+33.612345678");
    expect(normalizeGandiPhone("+33 06 12 34 56 78")).toBe("+33.612345678");
    expect(normalizeGandiPhone("0033612345678")).toBe("+33.612345678");
    expect(normalizeGandiPhone("+32 470 12 34 56")).toBe("+32.470123456");
    expect(normalizeGandiPhone("+352 621 123 456")).toBe("+352.621123456");
    expect(normalizeGandiPhone("0470123456", "BE")).toBeNull();
    expect(normalizeGandiPhone("12345")).toBeNull();
    expect(normalizeGandiPhone("abc")).toBeNull();
  });
});

describe("statuses and errors", () => {
  it("translates common statuses", () => {
    expect(describeGandiError(401, null, "x")).toMatch(/Jeton/);
    expect(describeGandiError(403, { message: "forbidden" }, "x")).toMatch(/droits/);
    expect(
      describeGandiError(400, { errors: [{ name: "owner.phone", description: "invalid" }] }, "x"),
    ).toMatch(/owner.phone : invalid/);
    expect(describeGandiError(429, null, "x")).toMatch(/Trop de requêtes/);
  });
  it("maps registry statuses", () => {
    expect(domainStatusFrom([])).toBe("active");
    expect(domainStatusFrom(["clientTransferProhibited"])).toBe("active");
    expect(domainStatusFrom(["pendingCreate"])).toBe("pending");
    expect(domainStatusFrom(["pendingCreate", "clientHold"])).toBe("pending");
    expect(domainStatusFrom(["clientHold"])).toBe("other");
    expect(domainStatusFrom(["redemptionPeriod"])).toBe("other");
  });
  it("orderFromDomainInfo", () => {
    expect(orderFromDomainInfo("a.fr", null).status).toBe("pending");
    expect(
      orderFromDomainInfo("a.fr", {
        fqdn: "a.fr",
        dates: { registry_ends_at: "2027-09-01T00:00:00Z" },
      }),
    ).toMatchObject({ status: "registered" });
    expect(orderFromDomainInfo("a.fr", { fqdn: "a.fr", status: ["pendingCreate"] }).status).toBe(
      "pending",
    );
  });
});

describe("quoteTxtValue", () => {
  it("quotes, keeps quoted values and splits long values", () => {
    expect(quoteTxtValue("v=spf1 include:amazonses.com ~all")).toBe(
      '"v=spf1 include:amazonses.com ~all"',
    );
    expect(quoteTxtValue('"v=spf1 -all"')).toBe('"v=spf1 -all"');
    expect(quoteTxtValue('"a" "b"')).toBe('"a" "b"');
    expect(quoteTxtValue('say "hi"')).toBe('"say \\"hi\\""');
    const long = `p=${"A".repeat(400)}`;
    const quoted = quoteTxtValue(long);
    const parts = quoted.match(/"[^"]*"/g)!;
    expect(parts).toHaveLength(2);
    expect(parts[0].length - 2).toBe(255);
    expect(parts.map((p) => p.slice(1, -1)).join("")).toBe(long);
    expect(quoteTxtValue(`"${long}"`)).toBe(quoted);
  });
});

describe("GandiProvider with a fake API", () => {
  it("checks availability with sharing_id and caches", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
    });
    const p = new GandiProvider({ apiKey: "tok", organizationId: "org-1" }, impl);
    const a = await p.check("boulangerie-dupont.fr");
    await p.check("boulangerie-dupont.fr");
    expect(a.available).toBe(true);
    // One availability call and one best-effort renewal lookup, then the cache.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("sharing_id=org-1");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("reads the renewal price when Gandi returns it", async () => {
    const { impl } = fakeFetch({
      [`GET ${API}/domain/check`]: (c) =>
        c.url.includes("processes=renew")
          ? {
              status: 200,
              body: {
                products: [
                  {
                    name: "boulangerie-dupont.fr",
                    status: "available",
                    process: "renew",
                    prices: [{ price_after_taxes: 18 }],
                  },
                ],
              },
            }
          : { status: 200, body: CHECK_AVAILABLE },
    });
    const a = await new GandiProvider({ apiKey: "tok" }, impl).check("boulangerie-dupont.fr");
    expect(a).toMatchObject({ price: 15.6, renewPrice: 18 });
  });

  it("dry-runs before buying, then polls until registered and enables autorenew", async () => {
    let lookups = 0;
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
      [`POST ${API}/domain/domains`]: (c) =>
        c.headers["Dry-Run"]
          ? { status: 200, body: { status: "success" } }
          : {
              status: 202,
              body: { message: "Creation operation for boulangerie-dupont.fr has been scheduled" },
            },
      [`GET ${API}/domain/domains/boulangerie-dupont.fr/livedns`]: () => ({
        status: 200,
        body: { current: "livedns", nameservers: ["ns-1-a.gandi.net"] },
      }),
      [`GET ${API}/domain/domains/boulangerie-dupont.fr`]: () => {
        lookups++;
        if (lookups <= 2) return { status: 404, body: { message: "not found" } };
        if (lookups === 3)
          return {
            status: 200,
            body: { fqdn: "boulangerie-dupont.fr", status: ["pendingCreate"] },
          };
        return {
          status: 200,
          body: {
            fqdn: "boulangerie-dupont.fr",
            status: ["clientTransferProhibited"],
            dates: { registry_ends_at: "2027-09-01T10:00:00Z" },
            autorenew: { enabled: false },
          },
        };
      },
      [`PATCH ${API}/domain/domains/boulangerie-dupont.fr/autorenew`]: () => ({
        status: 200,
        body: {},
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    const order = await p.register("boulangerie-dupont.fr", CONTACT, {
      expectedPrice: 15.6,
      currency: "EUR",
    });
    expect(order.status).toBe("pending");
    expect(order.orderId).toMatch(/^boulangerie-dupont\.fr@\d+$/);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].headers["Dry-Run"]).toBe("1");
    expect(posts[1].headers["Dry-Run"]).toBeUndefined();
    expect(posts[1].body).toMatchObject({
      fqdn: "boulangerie-dupont.fr",
      duration: 1,
      owner: { orgname: "AUSCII" },
    });
    expect(posts[1].body).not.toHaveProperty("enforce_premium");

    expect((await p.getOrder(order.orderId)).status).toBe("pending"); // 404
    const creating = await p.getOrder(order.orderId); // pendingCreate
    expect(creating.status).toBe("pending");
    expect(creating.message).toMatch(/pendingCreate/);
    const done = await p.getOrder(order.orderId);
    expect(done.status).toBe("registered");
    expect(done.expiresAt?.toISOString()).toBe("2027-09-01T10:00:00.000Z");
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.body && (c.body as { enabled: boolean }).enabled === true,
      ),
    ).toBe(true);
  });

  it("refuses to buy above the confirmed price, without any order", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
      [`GET ${API}/domain/domains/`]: () => ({ status: 404, body: {} }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await expect(
      p.register("boulangerie-dupont.fr", CONTACT, { expectedPrice: 12, currency: "EUR" }),
    ).rejects.toThrow(/15\.60 € au lieu de 12\.00 €/);
    await expect(
      p.register("boulangerie-dupont.fr", CONTACT, { expectedPrice: 20, currency: "USD" }),
    ).rejects.toThrow(/EUR/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("buys a premium name only at the confirmed price, with enforce_premium", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_PREMIUM),
      [`GET ${API}/domain/domains/`]: () => ({ status: 404, body: {} }),
      [`POST ${API}/domain/domains`]: (c) =>
        c.headers["Dry-Run"]
          ? { status: 200, body: { status: "success" } }
          : { status: 202, body: {} },
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await expect(p.register("paris.fr", CONTACT)).rejects.toThrow(/premium/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const order = await p.register("paris.fr", CONTACT, { expectedPrice: 1200, currency: "EUR" });
    expect(order.status).toBe("pending");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts)
      expect(post.body).toMatchObject({ enforce_premium: true, price: 1000, currency: "EUR" });
  });

  it("reads the dry-run body: status error with a 200 is a refusal", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
      [`GET ${API}/domain/domains/`]: () => ({ status: 404, body: {} }),
      [`POST ${API}/domain/domains`]: () => ({
        status: 200,
        body: {
          status: "error",
          errors: [{ location: "body", name: "owner.phone", description: "invalid format" }],
        },
      }),
    });
    const order = await new GandiProvider({ apiKey: "tok" }, impl).register(
      "boulangerie-dupont.fr",
      CONTACT,
      { expectedPrice: 15.6 },
    );
    expect(order.status).toBe("failed");
    expect(order.message).toMatch(/owner.phone : invalid format/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses to buy when the dry run fails or the contact is incomplete", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
      [`GET ${API}/domain/domains/`]: () => ({ status: 404, body: {} }),
      [`POST ${API}/domain/domains`]: () => ({
        status: 400,
        body: { errors: [{ name: "owner.zip", description: "required" }] },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    const incomplete = await p.register("boulangerie-dupont.fr", { email: "a@b.c" });
    expect(incomplete.status).toBe("failed");
    expect(calls).toHaveLength(0);
    const refused = await p.register("boulangerie-dupont.fr", CONTACT, { expectedPrice: 15.6 });
    expect(refused.status).toBe("failed");
    expect(refused.message).toMatch(/owner.zip/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("never buys a domain already in the account (resume after a crash)", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/domains/dupont.fr/livedns`]: () => ({
        status: 200,
        body: { current: "livedns" },
      }),
      [`GET ${API}/domain/domains/dupont.fr`]: (_c, n) => ({
        status: 200,
        body: {
          fqdn: "dupont.fr",
          status: n === 1 ? ["pendingCreate"] : [],
          dates: { registry_ends_at: "2027-01-01T00:00:00Z" },
        },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    expect((await p.register("dupont.fr", CONTACT, { expectedPrice: 15.6 })).status).toBe(
      "pending",
    );
    expect((await p.register("dupont.fr", CONTACT, { expectedPrice: 15.6 })).status).toBe(
      "registered",
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("/domain/check"))).toBe(false);
  });

  it("marks an order failed when the domain never appears after 24 hours", async () => {
    const { impl } = fakeFetch({
      [`GET ${API}/domain/domains/dupont.fr`]: () => ({ status: 404, body: {} }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    expect((await p.getOrder(orderIdFor("dupont.fr"))).status).toBe("pending");
    expect((await p.getOrder("dupont.fr")).status).toBe("pending");
    const old = await p.getOrder(orderIdFor("dupont.fr", Date.now() - 25 * 3600_000));
    expect(old.status).toBe("failed");
    expect(old.message).toMatch(/facturation/);
  });

  it("getDomain maps the status, the expiry, autorenew and LiveDNS", async () => {
    const { impl } = fakeFetch({
      [`GET ${API}/domain/domains/live.fr/livedns`]: () => ({
        status: 200,
        body: { current: "livedns" },
      }),
      [`GET ${API}/domain/domains/live.fr`]: () => ({
        status: 200,
        body: {
          fqdn: "live.fr",
          status: [],
          dates: { registry_ends_at: "2027-03-01T00:00:00Z" },
          autorenew: { enabled: true },
        },
      }),
      [`GET ${API}/domain/domains/elsewhere.fr/livedns`]: () => ({
        status: 200,
        body: { current: "other", nameservers: ["ns1.ovh.net"] },
      }),
      [`GET ${API}/domain/domains/elsewhere.fr`]: () => ({
        status: 200,
        body: { fqdn: "elsewhere.fr", status: ["clientHold"], nameservers: ["ns1.ovh.net"] },
      }),
      [`GET ${API}/domain/domains/fallback.fr/livedns`]: () => ({ status: 404, body: {} }),
      [`GET ${API}/domain/domains/fallback.fr`]: () => ({
        status: 200,
        body: { fqdn: "fallback.fr", nameservers: ["ns-12-a.gandi.net", "ns-34-b.gandi.net"] },
      }),
      [`GET ${API}/domain/domains/unknown.fr`]: () => ({ status: 404, body: {} }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    expect(await p.getDomain("live.fr")).toEqual({
      fqdn: "live.fr",
      status: "active",
      expiresAt: new Date("2027-03-01T00:00:00Z"),
      usesProviderDns: true,
      autorenew: true,
      registryStatus: [],
    });
    expect(await p.getDomain("elsewhere.fr")).toMatchObject({
      status: "other",
      usesProviderDns: false,
      autorenew: false,
    });
    expect((await p.getDomain("fallback.fr"))?.usesProviderDns).toBe(true);
    expect(await p.getDomain("unknown.fr")).toBeNull();
    expect(await p.domainInfo("live.fr")).toEqual({
      expiresAt: new Date("2027-03-01T00:00:00Z"),
      autorenew: true,
    });
  });

  it("writes LiveDNS records, quoting TXT values, and lists owned domains", async () => {
    const { impl, calls } = fakeFetch({
      [`PUT ${API}/livedns/domains/dupont.fr/records/`]: () => ({
        status: 201,
        body: { message: "ok" },
      }),
      [`GET ${API}/domain/domains?`]: () => ({
        status: 200,
        body: [{ fqdn: "auscii.site" }, { fqdn: "dupont.fr" }],
        headers: { "total-count": "2" },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await p.setRecords("dupont.fr", [
      { name: "@", type: "A", values: ["1.2.3.4"] },
      { name: "www", type: "A", values: ["1.2.3.4"], ttl: 600 },
      { name: "@", type: "ALIAS", values: ["x.example."] },
      { name: "send", type: "TXT", values: ["v=spf1 include:amazonses.com ~all"] },
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url)).toEqual([
      `${API}/livedns/domains/dupont.fr/records/%40/A`,
      `${API}/livedns/domains/dupont.fr/records/www/A`,
      `${API}/livedns/domains/dupont.fr/records/%40/ALIAS`,
      `${API}/livedns/domains/dupont.fr/records/send/TXT`,
    ]);
    expect(puts[1].body).toEqual({ rrset_ttl: 600, rrset_values: ["1.2.3.4"] });
    expect(puts[3].body).toEqual({
      rrset_ttl: 300,
      rrset_values: ['"v=spf1 include:amazonses.com ~all"'],
    });
    expect(await p.listOwned()).toEqual(["auscii.site", "dupont.fr"]);
  });

  it("deletes rrsets by type and ignores the missing ones", async () => {
    const { impl, calls } = fakeFetch({
      [`DELETE ${API}/livedns/domains/dupont.fr/records/%40/AAAA`]: () => ({ status: 204 }),
      [`DELETE ${API}/livedns/domains/dupont.fr/records/%40/ALIAS`]: () => ({
        status: 404,
        body: { message: "not found" },
      }),
      [`DELETE ${API}/livedns/domains/dupont.fr/records/%40/CNAME`]: () => ({ status: 204 }),
    });
    const removed = await new GandiProvider({ apiKey: "tok" }, impl).deleteRecords(
      "dupont.fr",
      "@",
      ["AAAA", "ALIAS", "CNAME"],
    );
    expect(removed).toEqual(["AAAA", "CNAME"]);
    expect(calls).toHaveLength(3);
  });

  it("surfaces auth errors as GandiError", async () => {
    const { impl } = fakeFetch({
      [`GET ${API}/domain/check`]: () => ({ status: 401, body: { message: "bad token" } }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await expect(p.check("a.fr")).rejects.toBeInstanceOf(GandiError);
    await expect(p.check("a.fr")).rejects.toThrow(/Jeton/);
  });

  it("retries reads on 5xx", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/domains/a.fr/livedns`]: () => ({ status: 200, body: {} }),
      [`GET ${API}/domain/domains/a.fr`]: (_c, n) =>
        n < 3 ? { status: 502, body: {} } : { status: 200, body: { fqdn: "a.fr" } },
    });
    expect((await new GandiProvider({ apiKey: "tok" }, impl).getDomain("a.fr"))?.status).toBe(
      "active",
    );
    expect(calls.filter((c) => c.url.endsWith("/domain/domains/a.fr"))).toHaveLength(3);
  });

  it("never leaks a token pasted with an inner newline", async () => {
    const secret = "pat_0123456789abcdef";
    let fetched = false;
    const p = new GandiProvider({ apiKey: ` ${secret}\nextra-line ` }, async () => {
      fetched = true;
      return new Response("{}");
    });
    const err = await p.check("a.fr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GandiError);
    expect((err as Error).message).toMatch(/retour à la ligne/);
    expect((err as Error).message).not.toContain(secret);
    expect(fetched).toBe(false);
  });

  it("trims a token pasted with spaces", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${API}/domain/check`]: checkRoute(CHECK_AVAILABLE),
    });
    await new GandiProvider({ apiKey: "  tok \n" }, impl).check("boulangerie-dupont.fr");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });
});
