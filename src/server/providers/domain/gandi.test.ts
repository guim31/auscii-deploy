import { describe, expect, it } from "vitest";
import {
  availabilityFromCheck,
  GandiProvider,
  missingContactFields,
  orderFromDomainInfo,
  toGandiOwner,
} from "./gandi";
import { describeGandiError, GandiError } from "./gandi-client";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(
  routes: Record<
    string,
    (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }
  >,
) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.includes(k));
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    const r = routes[key](call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  };
  return { impl, calls };
}

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

describe("availabilityFromCheck", () => {
  it("reads price and availability", () => {
    const a = availabilityFromCheck("boulangerie-dupont.fr", CHECK_AVAILABLE);
    expect(a).toMatchObject({ available: true, price: 15.6, currency: "EUR", premium: false });
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
});

describe("contact mapping", () => {
  it("maps the agency to a company owner", () => {
    expect(toGandiOwner(CONTACT)).toMatchObject({
      type: 1,
      orgname: "AUSCII",
      country: "FR",
      given: "Guilhem",
    });
    expect(missingContactFields(CONTACT)).toEqual([]);
    expect(missingContactFields({ email: "a@b.c" })).toContain("téléphone");
  });
});

describe("errors", () => {
  it("translates common statuses", () => {
    expect(describeGandiError(401, null, "x")).toMatch(/Jeton/);
    expect(describeGandiError(403, { message: "forbidden" }, "x")).toMatch(/droits/);
    expect(
      describeGandiError(400, { errors: [{ name: "owner.phone", description: "invalid" }] }, "x"),
    ).toMatch(/owner.phone : invalid/);
    expect(describeGandiError(429, null, "x")).toMatch(/Trop de requêtes/);
  });
  it("orderFromDomainInfo", () => {
    expect(orderFromDomainInfo("a.fr", null).status).toBe("pending");
    expect(
      orderFromDomainInfo("a.fr", {
        fqdn: "a.fr",
        dates: { registry_ends_at: "2027-09-01T00:00:00Z" },
      }),
    ).toMatchObject({ status: "registered" });
  });
});

describe("GandiProvider with a fake API", () => {
  it("checks availability with sharing_id and caches", async () => {
    const { impl, calls } = fakeFetch({
      "GET https://api.gandi.net/v5/domain/check": () => ({ status: 200, body: CHECK_AVAILABLE }),
    });
    const p = new GandiProvider({ apiKey: "tok", organizationId: "org-1" }, impl);
    const a = await p.check("boulangerie-dupont.fr");
    await p.check("boulangerie-dupont.fr");
    expect(a.available).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("sharing_id=org-1");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("dry-runs before buying, then polls until registered and enables autorenew", async () => {
    let lookups = 0;
    const { impl, calls } = fakeFetch({
      "POST https://api.gandi.net/v5/domain/domains": (c) =>
        c.headers["Dry-Run"]
          ? { status: 200, body: { status: "success" } }
          : {
              status: 202,
              body: { message: "Creation operation for boulangerie-dupont.fr has been scheduled" },
            },
      "GET https://api.gandi.net/v5/domain/domains/boulangerie-dupont.fr": () =>
        ++lookups < 2
          ? { status: 404, body: { message: "not found" } }
          : {
              status: 200,
              body: {
                fqdn: "boulangerie-dupont.fr",
                dates: { registry_ends_at: "2027-09-01T10:00:00Z" },
                autorenew: { enabled: false },
              },
            },
      "PATCH https://api.gandi.net/v5/domain/domains/boulangerie-dupont.fr/autorenew": () => ({
        status: 200,
        body: {},
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    const order = await p.register("boulangerie-dupont.fr", CONTACT);
    expect(order.status).toBe("pending");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(calls[0].headers["Dry-Run"]).toBe("1");
    expect(calls[1].body).toMatchObject({
      fqdn: "boulangerie-dupont.fr",
      duration: 1,
      owner: { orgname: "AUSCII" },
    });

    expect((await p.getOrder("boulangerie-dupont.fr")).status).toBe("pending");
    const done = await p.getOrder("boulangerie-dupont.fr");
    expect(done.status).toBe("registered");
    expect(done.expiresAt?.toISOString()).toBe("2027-09-01T10:00:00.000Z");
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.body && (c.body as { enabled: boolean }).enabled === true,
      ),
    ).toBe(true);
  });

  it("refuses to buy when the dry run fails or the contact is incomplete", async () => {
    const { impl, calls } = fakeFetch({
      "POST https://api.gandi.net/v5/domain/domains": () => ({
        status: 400,
        body: { errors: [{ name: "owner.zip", description: "required" }] },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    const incomplete = await p.register("a.fr", { email: "a@b.c" });
    expect(incomplete.status).toBe("failed");
    expect(calls).toHaveLength(0);
    const refused = await p.register("a.fr", CONTACT);
    expect(refused.status).toBe("failed");
    expect(refused.message).toMatch(/owner.zip/);
    expect(calls).toHaveLength(1);
  });

  it("writes LiveDNS records and lists owned domains", async () => {
    const { impl, calls } = fakeFetch({
      "PUT https://api.gandi.net/v5/livedns/domains/dupont.fr/records/": () => ({
        status: 201,
        body: { message: "ok" },
      }),
      "GET https://api.gandi.net/v5/domain/domains?": () => ({
        status: 200,
        body: [{ fqdn: "auscii.site" }, { fqdn: "dupont.fr" }],
        headers: { "total-count": "2" },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await p.setRecords("dupont.fr", [
      { name: "@", type: "A", values: ["1.2.3.4"] },
      { name: "www", type: "A", values: ["1.2.3.4"], ttl: 600 },
    ]);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([
      "https://api.gandi.net/v5/livedns/domains/dupont.fr/records/%40/A",
      "https://api.gandi.net/v5/livedns/domains/dupont.fr/records/www/A",
    ]);
    expect(calls[1].body).toEqual({ rrset_ttl: 600, rrset_values: ["1.2.3.4"] });
    expect(await p.listOwned()).toEqual(["auscii.site", "dupont.fr"]);
  });

  it("surfaces auth errors as GandiError", async () => {
    const { impl } = fakeFetch({
      "GET https://api.gandi.net/v5/domain/check": () => ({
        status: 401,
        body: { message: "bad token" },
      }),
    });
    const p = new GandiProvider({ apiKey: "tok" }, impl);
    await expect(p.check("a.fr")).rejects.toBeInstanceOf(GandiError);
    await expect(p.check("a.fr")).rejects.toThrow(/Jeton/);
  });
});
