import { describe, expect, it } from "vitest";
import { offersFromProducts, ScalewayProvider, stateFromScaleway } from "./scaleway";
import { describeScalewayError, ScalewayError } from "./scaleway-client";

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function fakeFetch(
  routes: Record<string, (call: Call, n: number) => { status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find(
      (k) => `${call.method} ${url}`.startsWith(k) || `${call.method} ${url}`.includes(k),
    );
    if (!key)
      return new Response(JSON.stringify({ message: `no route for ${call.method} ${url}` }), {
        status: 500,
      });
    counts[key] = (counts[key] ?? 0) + 1;
    const r = routes[key](call, counts[key]);
    return new Response(
      r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status },
    );
  };
  return { impl, calls };
}

const PRODUCTS = {
  servers: {
    "DEV1-S": {
      ncpus: 2,
      ram: 2147483648,
      hourly_price: 0.011,
      per_volume_constraint: { l_ssd: { min_size: 20000000000, max_size: 20000000000 } },
    },
    "DEV1-M": {
      ncpus: 3,
      ram: 4294967296,
      hourly_price: 0.0195,
      per_volume_constraint: { l_ssd: { min_size: 40000000000, max_size: 40000000000 } },
    },
    "GP1-XS": { ncpus: 4, ram: 17179869184, hourly_price: 0.08 },
    "PLAY2-NANO": {
      ncpus: 2,
      ram: 4294967296,
      hourly_price: 0.0266,
      volumes_constraint: { min_size: 10000000000, max_size: 60000000000 },
    },
  },
};
const AVAIL: { servers: Record<string, { availability: "available" | "scarce" | "shortage" }> } = {
  servers: {
    "DEV1-S": { availability: "available" },
    "DEV1-M": { availability: "shortage" },
    "PLAY2-NANO": { availability: "scarce" },
  },
};
const CREDS = { secretKey: "sk", projectId: "proj-1" };

describe("offersFromProducts", () => {
  it("keeps the cheap families, converts prices and hides shortages", () => {
    const offers = offersFromProducts(PRODUCTS, AVAIL);
    expect(offers.map((o) => o.id)).toEqual(["DEV1-S", "PLAY2-NANO"]);
    expect(offers[0]).toMatchObject({ vcpus: 2, ramGb: 2, diskGb: 20, monthlyPrice: 8.03 });
  });
  it("maps states", () => {
    expect(stateFromScaleway("running")).toBe("running");
    expect(stateFromScaleway("starting")).toBe("starting");
    expect(stateFromScaleway("stopped in place")).toBe("stopped");
    expect(stateFromScaleway("locked")).toBe("error");
  });
  it("translates errors", () => {
    expect(describeScalewayError(401, null, "x")).toMatch(/invalide/);
    expect(
      describeScalewayError(400, { type: "quotas_exceeded", message: "too many" }, "x"),
    ).toMatch(/Quota/);
    expect(
      describeScalewayError(400, { fields: { commercial_type: ["not available"] } }, "x"),
    ).toMatch(/commercial_type/);
  });
});

describe("ScalewayProvider", () => {
  it("creates an instance: image, ip, server, cloud-init, poweron", async () => {
    const { impl, calls } = fakeFetch({
      "GET https://api.scaleway.com/marketplace/v2/local-images": () => ({
        status: 200,
        body: { local_images: [{ id: "img-1", zone: "fr-par-1" }] },
      }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/ips": () => ({
        status: 201,
        body: { ip: { id: "ip-1", address: "51.15.1.2" } },
      }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1/action": () => ({
        status: 202,
        body: { task: {} },
      }),
      "PATCH https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1/user_data/cloud-init":
        () => ({ status: 204 }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/servers": () => ({
        status: 201,
        body: {
          server: {
            id: "srv-1",
            name: "vps-01",
            state: "stopped",
            volumes: { "0": { id: "vol-1" } },
          },
        },
      }),
    });
    const p = new ScalewayProvider(CREDS, impl);
    const s = await p.createServer({
      name: "vps-01",
      offer: "DEV1-S",
      zone: "fr-par-1",
      cloudInit: "#cloud-config\n",
    });
    expect(s).toMatchObject({
      providerId: "srv-1",
      ip: "51.15.1.2",
      state: "starting",
      metadata: { ipId: "ip-1", volumeIds: ["vol-1"] },
    });
    const methods = calls.map(
      (c) => `${c.method} ${c.url.replace("https://api.scaleway.com", "")}`,
    );
    expect(methods).toEqual([
      "GET /marketplace/v2/local-images?image_label=debian_bookworm&zone=fr-par-1&type=instance_local&per_page=10",
      "POST /instance/v1/zones/fr-par-1/ips",
      "POST /instance/v1/zones/fr-par-1/servers",
      "PATCH /instance/v1/zones/fr-par-1/servers/srv-1/user_data/cloud-init",
      "POST /instance/v1/zones/fr-par-1/servers/srv-1/action",
    ]);
    expect(JSON.parse(calls[2].body!)).toMatchObject({
      commercial_type: "DEV1-S",
      image: "img-1",
      project: "proj-1",
      public_ips: ["ip-1"],
    });
    expect(calls[3].headers["Content-Type"]).toBe("text/plain");
    expect(calls[3].body).toBe("#cloud-config\n");
    expect(calls[0].headers["X-Auth-Token"]).toBe("sk");
  });

  it("releases the IP when the server creation fails", async () => {
    const { impl, calls } = fakeFetch({
      "GET https://api.scaleway.com/marketplace/v2/local-images": () => ({
        status: 200,
        body: { local_images: [{ id: "img-1", zone: "fr-par-1" }] },
      }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/ips": () => ({
        status: 201,
        body: { ip: { id: "ip-1", address: "51.15.1.2" } },
      }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/servers": () => ({
        status: 400,
        body: { type: "out_of_stock", message: "DEV1-S" },
      }),
      "DELETE https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-1": () => ({
        status: 204,
      }),
    });
    const p = new ScalewayProvider(CREDS, impl);
    await expect(
      p.createServer({ name: "x", offer: "DEV1-S", zone: "fr-par-1", cloudInit: "" }),
    ).rejects.toThrow(/indisponible/);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/ips/ip-1"))).toBe(true);
  });

  it("reads the server state and ip", async () => {
    const { impl } = fakeFetch({
      "GET https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1": () => ({
        status: 200,
        body: {
          server: {
            id: "srv-1",
            name: "vps-01",
            state: "running",
            public_ip: { id: "ip-1", address: "51.15.1.2" },
          },
        },
      }),
    });
    const p = new ScalewayProvider(CREDS, impl);
    expect(await p.getServer("srv-1", "fr-par-1")).toMatchObject({
      state: "running",
      ip: "51.15.1.2",
    });
  });

  it("deletes the instance, its volumes and its ip, and tolerates a vanished instance", async () => {
    const { impl, calls } = fakeFetch({
      "GET https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1": (_c, n) => ({
        status: 200,
        body: {
          server: {
            id: "srv-1",
            name: "x",
            state: n === 1 ? "running" : "stopped",
            volumes: { "0": { id: "vol-1" } },
            public_ip: { id: "ip-1" },
          },
        },
      }),
      "POST https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1/action": () => ({
        status: 202,
        body: {},
      }),
      "DELETE https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1": () => ({
        status: 204,
      }),
      "DELETE https://api.scaleway.com/instance/v1/zones/fr-par-1/volumes/vol-1": () => ({
        status: 404,
        body: { message: "gone" },
      }),
      "DELETE https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-1": () => ({
        status: 204,
      }),
      "GET https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-2": () => ({
        status: 404,
        body: { message: "not found" },
      }),
      "DELETE https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-2": () => ({
        status: 204,
      }),
    });
    const p = new ScalewayProvider(CREDS, impl);
    await p.deleteServer("srv-1", "fr-par-1", { ipId: "ip-1", volumeIds: ["vol-1"] });
    const deletes = calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.split("fr-par-1")[1]);
    expect(deletes).toEqual(["/servers/srv-1", "/volumes/vol-1", "/ips/ip-1"]);
    expect(calls.some((c) => c.method === "POST" && c.body?.includes("poweroff"))).toBe(true);
    await p.deleteServer("srv-2", "fr-par-1", { ipId: "ip-2" });
    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("fr-par-1")[1]),
    ).toContain("/ips/ip-2");
  });

  it("surfaces auth errors", async () => {
    const { impl } = fakeFetch({
      "GET https://api.scaleway.com/instance/v1/zones/fr-par-1/products/servers": () => ({
        status: 401,
        body: { message: "bad" },
      }),
    });
    const p = new ScalewayProvider(CREDS, impl);
    await expect(p.listOffers("fr-par-1")).rejects.toBeInstanceOf(ScalewayError);
  });
});
