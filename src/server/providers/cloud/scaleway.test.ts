import { describe, expect, it } from "vitest";
import {
  offersFromProducts,
  pickImage,
  rootVolumeFor,
  ScalewayProvider,
  stateFromScaleway,
} from "./scaleway";
import { describeScalewayError, ScalewayError } from "./scaleway-client";
import { ServerOrderIncompleteError, type CloudServer } from "../types";

type Call = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
};
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = [RegExp, (call: Call, n: number) => Reply];

/** Routes are regexes on "METHOD /path?query" (host stripped), tried in order. */
function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const counts = new Map<RegExp, number>();
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.replace("https://api.scaleway.com", ""),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${call.path}`));
    if (!route)
      return new Response(JSON.stringify({ message: `no route for ${call.method} ${call.path}` }), {
        status: 418,
      });
    const n = (counts.get(route[0]) ?? 0) + 1;
    counts.set(route[0], n);
    const r = route[1](call, n);
    return new Response(
      r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status, headers: r.headers },
    );
  };
  return { impl, calls, list: () => calls.map((c) => `${c.method} ${c.path.split("?")[0]}`) };
}

const Z = "/instance/v1/zones/fr-par-1";

const PRODUCTS = {
  servers: {
    "DEV1-S": {
      ncpus: 2,
      ram: 2147483648,
      hourly_price: 0.011,
      arch: "x86_64",
      volumes_constraint: { min_size: 20000000000, max_size: 20000000000 },
      per_volume_constraint: { l_ssd: { min_size: 1000000000, max_size: 20000000000 } },
    },
    "DEV1-M": {
      ncpus: 3,
      ram: 4294967296,
      hourly_price: 0.0195,
      arch: "x86_64",
      volumes_constraint: { min_size: 40000000000, max_size: 40000000000 },
      per_volume_constraint: { l_ssd: { min_size: 1000000000, max_size: 40000000000 } },
    },
    "DEV1-XL": {
      ncpus: 4,
      ram: 12884901888,
      hourly_price: 0.06,
      arch: "x86_64",
      end_of_service: true,
      volumes_constraint: { min_size: 120000000000, max_size: 120000000000 },
    },
    "GP1-XS": { ncpus: 4, ram: 17179869184, hourly_price: 0.08 },
    "PLAY2-NANO": {
      ncpus: 2,
      ram: 4294967296,
      hourly_price: 0.0266,
      monthly_price: 19.42,
      arch: "x86_64",
      volumes_constraint: { min_size: 0, max_size: 0 },
    },
  },
  total_count: 5,
};
const AVAIL: { servers: Record<string, { availability: "available" | "scarce" | "shortage" }> } = {
  servers: {
    "DEV1-S": { availability: "available" },
    "DEV1-M": { availability: "shortage" },
    "PLAY2-NANO": { availability: "scarce" },
  },
};
const CREDS = { secretKey: "sk", projectId: "proj-1" };
const IMAGES = {
  local_images: [
    {
      id: "img-arm",
      zone: "fr-par-1",
      arch: "arm64",
      compatible_commercial_types: ["COPARM1-2C-8G"],
    },
    {
      id: "img-sbs",
      zone: "fr-par-1",
      arch: "x86_64",
      compatible_commercial_types: ["PLAY2-NANO", "PRO2-XXS"],
    },
    { id: "img-1", zone: "fr-par-1", arch: "x86_64", compatible_commercial_types: ["DEV1-S"] },
  ],
  total_count: 3,
};

function catalogRoutes(): Route[] {
  return [
    [/^GET \/instance\/v1\/zones\/fr-par-1\/products\/servers\/availability/, () => ({ status: 200, body: AVAIL })],
    [/^GET \/instance\/v1\/zones\/fr-par-1\/products\/servers\?/, () => ({ status: 200, body: PRODUCTS })],
    [/^GET \/marketplace\/v2\/local-images/, () => ({ status: 200, body: IMAGES })],
    [/^GET \/block\/v1\/zones\/fr-par-1\/volume-types/, () => ({
      status: 200,
      body: {
        volume_types: [
          { type: "sbs_15k", pricing: { currency_code: "EUR", units: 0, nanos: 200000 } },
          { type: "sbs_5k", pricing: { currency_code: "EUR", units: 0, nanos: 110000 } },
        ],
      },
    })],
  ]; // prettier-ignore
}

function orderRoutes(extra: Route[] = [], serverName = "vps-01"): Route[] {
  return [
    ...extra,
    [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\?name=/, () => ({
      status: 200,
      body: { servers: [{ id: "other", name: `${serverName}0`, state: "running", tags: ["auscii-deploy"] }], total_count: 1 },
    })],
    [/^GET \/instance\/v1\/zones\/fr-par-1\/ips\?/, () => ({ status: 200, body: { ips: [] } })],
    [/^POST \/instance\/v1\/zones\/fr-par-1\/ips$/, () => ({
      status: 201,
      body: { ip: { id: "ip-1", address: "51.15.1.2" } },
    })],
    [/^POST \/instance\/v1\/zones\/fr-par-1\/servers\/srv-1\/action$/, () => ({ status: 202, body: { task: {} } })],
    [/^PATCH \/instance\/v1\/zones\/fr-par-1\/servers\/srv-1\/user_data\/cloud-init$/, () => ({ status: 204 })],
    [/^POST \/instance\/v1\/zones\/fr-par-1\/servers$/, (c) => ({
      status: 201,
      body: {
        server: {
          id: "srv-1",
          name: serverName,
          state: "stopped",
          volumes: {
            "0": { id: "vol-1", volume_type: JSON.parse(c.body!).volumes["0"].volume_type },
          },
        },
      },
    })],
    ...catalogRoutes(),
  ]; // prettier-ignore
}

describe("offersFromProducts", () => {
  it("keeps the cheap families, drops end of service and shortages, prefers monthly_price", () => {
    const offers = offersFromProducts(PRODUCTS, AVAIL);
    expect(offers.map((o) => o.id)).toEqual(["DEV1-S", "PLAY2-NANO"]);
    expect(offers[0]).toMatchObject({
      vcpus: 2,
      ramGb: 2,
      diskGb: 20,
      monthlyPrice: 8.03,
      storage: "l_ssd",
      arch: "x86_64",
    });
    expect(offers[1]).toMatchObject({ monthlyPrice: 19.42, diskGb: 20, storage: "sbs_volume" });
  });

  it("adds the IPv4 and the block root volume to the estimate", () => {
    const offers = offersFromProducts(PRODUCTS, AVAIL, {
      sbsPerGbHour: 0.00011,
      ipv4Monthly: 2.92,
    });
    const play = offers.find((o) => o.id === "PLAY2-NANO")!;
    // 20 GB × 0.00011 €/GB/h × 730 h = 1.61 €
    expect(play.priceBreakdown).toEqual({ instance: 19.42, ipv4: 2.92, volume: 1.61 });
    expect(play.monthlyPrice).toBe(23.95);
    const dev = offers.find((o) => o.id === "DEV1-S")!;
    expect(dev.priceBreakdown).toEqual({ instance: 8.03, ipv4: 2.92, volume: undefined });
    expect(dev.monthlyPrice).toBe(10.95);
  });

  it("sizes the root volume within the offer constraints", () => {
    expect(rootVolumeFor("DEV1-S", PRODUCTS.servers["DEV1-S"])).toEqual({
      size: 20000000000,
      volume_type: "l_ssd",
    });
    expect(rootVolumeFor("DEV1-M", PRODUCTS.servers["DEV1-M"]).size).toBe(40000000000);
    expect(rootVolumeFor("PLAY2-NANO", PRODUCTS.servers["PLAY2-NANO"])).toEqual({
      size: 20000000000,
      volume_type: "sbs_volume",
    });
  });

  it("picks the image of the right architecture and commercial type", () => {
    expect(pickImage(IMAGES.local_images, "fr-par-1", "DEV1-S", "x86_64")?.id).toBe("img-1");
    expect(pickImage(IMAGES.local_images, "fr-par-1", "PLAY2-NANO", "x86_64")?.id).toBe("img-sbs");
    expect(pickImage(IMAGES.local_images, "fr-par-1", "DEV1-S", "arm64")).toBeUndefined();
    expect(pickImage(IMAGES.local_images, "nl-ams-1", "DEV1-S", "x86_64")).toBeUndefined();
  });

  it("maps states", () => {
    expect(stateFromScaleway("running")).toBe("running");
    expect(stateFromScaleway("starting")).toBe("starting");
    expect(stateFromScaleway("stopped in place")).toBe("stopped");
    expect(stateFromScaleway("locked")).toBe("error");
  });
});

describe("describeScalewayError", () => {
  it("reads the error type before the HTTP status", () => {
    expect(describeScalewayError(401, null, "x")).toMatch(/invalide/);
    const quota = describeScalewayError(
      403,
      {
        type: "quotas_exceeded",
        message: "Quotas exceeded",
        details: [{ resource: "instances_dev1_s", quota: 2, current: 2 }],
      },
      "x",
    );
    expect(quota).toMatch(/Quota Scaleway atteint \(instances_dev1_s 2\/2\)/);
    expect(quota).not.toMatch(/permissions/);
    expect(describeScalewayError(400, { type: "out_of_stock", message: "DEV1-S" }, "x")).toMatch(
      /rupture de stock/,
    );
    expect(describeScalewayError(403, { type: "permissions_denied", message: "no" }, "x")).toMatch(
      /BlockStorageFullAccess/,
    );
    expect(
      describeScalewayError(
        400,
        {
          type: "invalid_arguments",
          details: [{ argument_name: "volumes", help_message: "total size must be 20GB" }],
        },
        "x",
      ),
    ).toMatch(/volumes : total size must be 20GB/);
    expect(
      describeScalewayError(400, { fields: { commercial_type: ["not available"] } }, "x"),
    ).toMatch(/commercial_type/);
  });
});

describe("ScalewayProvider.listOffers", () => {
  it("paginates the catalog with per_page, using total_count", async () => {
    const page1 = { servers: { "DEV1-S": PRODUCTS.servers["DEV1-S"] }, total_count: 2 };
    const page2 = { servers: { "PLAY2-NANO": PRODUCTS.servers["PLAY2-NANO"] }, total_count: 2 };
    const { impl, calls } = fakeFetch([
      [/products\/servers\/availability/, () => ({ status: 200, body: { servers: {} } })],
      [/products\/servers\?per_page=100&page=1$/, () => ({ status: 200, body: page1 })],
      [/products\/servers\?per_page=100&page=2$/, () => ({ status: 200, body: page2 })],
      [/volume-types/, () => ({ status: 403, body: { type: "permissions_denied" } })],
    ]);
    const offers = await new ScalewayProvider(CREDS, impl).listOffers("fr-par-1");
    expect(offers.map((o) => o.id).sort()).toEqual(["DEV1-S", "PLAY2-NANO"]);
    expect(calls.filter((c) => c.path.includes("products/servers?"))).toHaveLength(2);
    // Without the Block API price, the volume is left out and said so in the breakdown.
    expect(offers.find((o) => o.id === "PLAY2-NANO")?.priceBreakdown?.volume).toBeUndefined();
    expect(offers.find((o) => o.id === "PLAY2-NANO")?.priceBreakdown?.ipv4).toBe(2.92);
  });

  it("surfaces auth errors", async () => {
    const { impl } = fakeFetch([
      [/products\/servers/, () => ({ status: 401, body: { message: "bad" } })],
    ]);
    await expect(new ScalewayProvider(CREDS, impl).listOffers("fr-par-1")).rejects.toBeInstanceOf(
      ScalewayError,
    );
  });

  it("retries reads on 503", async () => {
    const { impl, calls } = fakeFetch([
      [/products\/servers\/availability/, () => ({ status: 200, body: AVAIL })],
      [
        /products\/servers\?/,
        (_c, n) => (n < 3 ? { status: 503 } : { status: 200, body: PRODUCTS }),
      ],
      [/volume-types/, () => ({ status: 200, body: { volume_types: [] } })],
    ]);
    expect(await new ScalewayProvider(CREDS, impl).listOffers("fr-par-1")).toHaveLength(2);
    expect(calls.filter((c) => c.path.includes("products/servers?"))).toHaveLength(3);
  });
});

describe("ScalewayProvider.createServer", () => {
  it("creates an instance: image, ip, server, onCreated, cloud-init, poweron", async () => {
    const { impl, calls, list } = fakeFetch(orderRoutes());
    const p = new ScalewayProvider(CREDS, impl);
    const events: string[] = [];
    let created: CloudServer | null = null;
    const s = await p.createServer(
      { name: "vps-01", offer: "DEV1-S", zone: "fr-par-1", cloudInit: "#cloud-config\n" },
      {
        onCreated: async (server) => {
          created = server;
          events.push(`created after ${calls.length} calls`);
        },
      },
    );
    expect(s).toMatchObject({
      providerId: "srv-1",
      ip: "51.15.1.2",
      state: "starting",
      metadata: { ipId: "ip-1", volumeIds: ["vol-1"], volumes: [{ id: "vol-1", type: "l_ssd" }] },
    });
    expect(created).toMatchObject({ providerId: "srv-1", metadata: { ipId: "ip-1" } });
    const sequence = list().filter((l) => !l.includes("products") && !l.includes("volume-types"));
    expect(sequence).toEqual([
      `GET ${Z}/servers`,
      "GET /marketplace/v2/local-images",
      `GET ${Z}/ips`,
      `POST ${Z}/ips`,
      `POST ${Z}/servers`,
      `PATCH ${Z}/servers/srv-1/user_data/cloud-init`,
      `POST ${Z}/servers/srv-1/action`,
    ]);
    // onCreated runs right after the POST, before cloud-init and power-on.
    const postIndex = calls.findIndex((c) => c.method === "POST" && c.path === `${Z}/servers`);
    expect(events).toEqual([`created after ${postIndex + 1} calls`]);

    const imageCall = calls.find((c) => c.path.startsWith("/marketplace"))!;
    expect(imageCall.path).toContain("page_size=100");
    expect(imageCall.path).not.toContain("per_page");
    expect(imageCall.path).toContain("arch=x86_64");
    expect(imageCall.path).toContain("type=instance_local");
    const serverBody = JSON.parse(
      calls.find((c) => c.path === `${Z}/servers` && c.method === "POST")!.body!,
    );
    expect(serverBody).toMatchObject({
      commercial_type: "DEV1-S",
      image: "img-1",
      project: "proj-1",
      public_ips: ["ip-1"],
      tags: ["auscii-deploy"],
      volumes: { "0": { size: 20000000000, volume_type: "l_ssd" } },
    });
    const ipBody = JSON.parse(
      calls.find((c) => c.path === `${Z}/ips` && c.method === "POST")!.body!,
    );
    expect(ipBody.tags).toEqual(["auscii-deploy", "auscii-deploy:vps-01"]);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["Content-Type"]).toBe("text/plain");
    expect(patch.body).toBe("#cloud-config\n");
    expect(calls[0].headers["X-Auth-Token"]).toBe("sk");
  });

  it("gives block-storage offers an SBS root volume and the SBS image", async () => {
    const { impl, calls } = fakeFetch(orderRoutes());
    await new ScalewayProvider(CREDS, impl).createServer({
      name: "vps-01",
      offer: "PLAY2-NANO",
      zone: "fr-par-1",
      cloudInit: "",
    });
    const serverBody = JSON.parse(
      calls.find((c) => c.path === `${Z}/servers` && c.method === "POST")!.body!,
    );
    expect(serverBody).toMatchObject({
      image: "img-sbs",
      volumes: { "0": { size: 20000000000, volume_type: "sbs_volume" } },
    });
    expect(calls.find((c) => c.path.startsWith("/marketplace"))!.path).toContain(
      "type=instance_sbs",
    );
  });

  it("never substitutes an offer that is unknown, out of stock or at end of service", async () => {
    for (const offer of ["DEV1-M", "DEV1-XL", "GP1-M"]) {
      const { impl, calls } = fakeFetch(orderRoutes());
      await expect(
        new ScalewayProvider(CREDS, impl).createServer({
          name: "vps-01",
          offer,
          zone: "fr-par-1",
          cloudInit: "",
        }),
      ).rejects.toThrow(/Rien n'a été commandé/);
      expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    }
  });

  it("releases the IP when the server creation fails", async () => {
    const { impl, calls } = fakeFetch(
      orderRoutes([
        [/^POST \/instance\/v1\/zones\/fr-par-1\/servers$/, () => ({
          status: 400,
          body: { type: "out_of_stock", message: "DEV1-S" },
        })],
        [/^DELETE \/instance\/v1\/zones\/fr-par-1\/ips\/ip-1$/, () => ({ status: 204 })],
      ]),
    ); // prettier-ignore
    const p = new ScalewayProvider(CREDS, impl);
    await expect(
      p.createServer({ name: "vps-01", offer: "DEV1-S", zone: "fr-par-1", cloudInit: "" }),
    ).rejects.toThrow(/rupture de stock/);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/ips/ip-1"))).toBe(true);
  });

  it("keeps the instance id when cloud-init or power-on fails", async () => {
    const { impl } = fakeFetch(
      orderRoutes([
        [/^POST \/instance\/v1\/zones\/fr-par-1\/servers\/srv-1\/action$/, () => ({
          status: 500,
          body: { message: "boom" },
        })],
      ]),
    ); // prettier-ignore
    const persisted: string[] = [];
    const err = await new ScalewayProvider(CREDS, impl)
      .createServer(
        { name: "vps-01", offer: "DEV1-S", zone: "fr-par-1", cloudInit: "" },
        { onCreated: async (s) => void persisted.push(s.providerId) },
      )
      .catch((e: unknown) => e);
    expect(persisted).toEqual(["srv-1"]);
    expect(err).toBeInstanceOf(ServerOrderIncompleteError);
    expect((err as ServerOrderIncompleteError).server.providerId).toBe("srv-1");
    expect((err as Error).message).toMatch(/srv-1/);
  });

  it("resumes an interrupted order: adopts the instance of the same name instead of ordering again", async () => {
    const { impl, calls } = fakeFetch(
      orderRoutes([
        [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\?name=vps-01/, () => ({
          status: 200,
          body: {
            servers: [
              { id: "srv-1", name: "vps-01", state: "stopped", commercial_type: "DEV1-S", tags: ["auscii-deploy"],
                public_ip: { id: "ip-1", address: "51.15.1.2" }, volumes: { "0": { id: "vol-1", volume_type: "l_ssd" } } },
            ],
            total_count: 1,
          },
        })],
      ]),
    ); // prettier-ignore
    const created: string[] = [];
    const s = await new ScalewayProvider(CREDS, impl).createServer(
      { name: "vps-01", offer: "DEV1-S", zone: "fr-par-1", cloudInit: "#cloud-config" },
      { onCreated: async (srv) => void created.push(srv.providerId) },
    );
    expect(s).toMatchObject({ providerId: "srv-1", ip: "51.15.1.2" });
    expect(created).toEqual(["srv-1"]);
    expect(calls.some((c) => c.method === "POST" && c.path === `${Z}/servers`)).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path === `${Z}/ips`)).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/action"))).toBe(true);
  });

  it("reuses the routed IP left by an order interrupted before the instance", async () => {
    const { impl, calls } = fakeFetch(
      orderRoutes([
        [/^GET \/instance\/v1\/zones\/fr-par-1\/ips\?tags=auscii-deploy%3Avps-01/, () => ({
          status: 200,
          body: { ips: [{ id: "ip-old", address: "51.15.9.9", server: null }] },
        })],
      ]),
    ); // prettier-ignore
    const s = await new ScalewayProvider(CREDS, impl).createServer({
      name: "vps-01",
      offer: "DEV1-S",
      zone: "fr-par-1",
      cloudInit: "",
    });
    expect(s).toMatchObject({ ip: "51.15.9.9", metadata: { ipId: "ip-old" } });
    expect(calls.some((c) => c.method === "POST" && c.path === `${Z}/ips`)).toBe(false);
  });
});

describe("ScalewayProvider.findServerByName", () => {
  it("filters by tag and keeps exact names only", async () => {
    const { impl, calls } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\?/, () => ({
        status: 200,
        body: {
          servers: [
            { id: "a", name: "vps-10", state: "running", tags: ["auscii-deploy"] },
            { id: "b", name: "vps-1", state: "running", tags: ["auscii-deploy"], public_ip: { id: "ip", address: "1.2.3.4" } },
          ],
          total_count: 2,
        },
      })],
    ]); // prettier-ignore
    const p = new ScalewayProvider(CREDS, impl);
    expect(await p.findServerByName("vps-1", "fr-par-1")).toMatchObject({
      providerId: "b",
      ip: "1.2.3.4",
      state: "running",
    });
    expect(calls[0].path).toContain("name=vps-1");
    expect(calls[0].path).toContain("tags=auscii-deploy");
    expect(calls[0].path).toContain("project=proj-1");
    expect(await p.findServerByName("vps-2", "fr-par-1")).toBeNull();
  });
});

describe("ScalewayProvider.getServer", () => {
  it("reads the server state and ip", async () => {
    const { impl } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\/srv-1$/, () => ({
        status: 200,
        body: { server: { id: "srv-1", name: "vps-01", state: "running", public_ip: { id: "ip-1", address: "51.15.1.2" } } },
      })],
    ]); // prettier-ignore
    expect(await new ScalewayProvider(CREDS, impl).getServer("srv-1", "fr-par-1")).toMatchObject({
      state: "running",
      ip: "51.15.1.2",
    });
  });
});

describe("ScalewayProvider.deleteServer", () => {
  it("deletes the instance, its local volume and its ip", async () => {
    const { impl, calls } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\/srv-1$/, (_c, n) => ({
        status: 200,
        body: { server: { id: "srv-1", name: "x", state: n === 1 ? "running" : "stopped",
          volumes: { "0": { id: "vol-1", volume_type: "l_ssd" } }, public_ip: { id: "ip-1" } } },
      })],
      [/^POST .*\/servers\/srv-1\/action$/, () => ({ status: 202, body: {} })],
      [/^DELETE .*\/servers\/srv-1$/, () => ({ status: 204 })],
      [/^DELETE .*\/volumes\/vol-1$/, () => ({ status: 204 })],
      [/^DELETE .*\/ips\/ip-1$/, () => ({ status: 204 })],
    ]); // prettier-ignore
    await new ScalewayProvider(CREDS, impl).deleteServer("srv-1", "fr-par-1", {
      ipId: "ip-1",
      volumeIds: ["vol-1"],
    });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `${Z}/servers/srv-1`,
      `${Z}/volumes/vol-1`,
      `${Z}/ips/ip-1`,
    ]);
    expect(calls.some((c) => c.method === "POST" && c.body?.includes("poweroff"))).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/block"))).toBe(false);
  });

  it("deletes block storage volumes through the Block API once detached", async () => {
    const { impl, calls } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\/srv-2$/, () => ({
        status: 200,
        body: { server: { id: "srv-2", name: "x", state: "stopped",
          volumes: { "0": { id: "sbs-1", volume_type: "sbs_volume" } }, public_ip: { id: "ip-2" } } },
      })],
      [/^DELETE .*\/servers\/srv-2$/, () => ({ status: 204 })],
      [/^GET \/block\/v1\/zones\/fr-par-1\/volumes\/sbs-1$/, (_c, n) => ({
        status: 200,
        body: { id: "sbs-1", status: n === 1 ? "in_use" : "available" },
      })],
      [/^DELETE \/block\/v1\/zones\/fr-par-1\/volumes\/sbs-1$/, () => ({ status: 204 })],
      [/^DELETE .*\/ips\/ip-2$/, () => ({ status: 204 })],
    ]); // prettier-ignore
    await new ScalewayProvider(CREDS, impl).deleteServer("srv-2", "fr-par-1", { ipId: "ip-2" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `${Z}/servers/srv-2`,
      "/block/v1/zones/fr-par-1/volumes/sbs-1",
      `${Z}/ips/ip-2`,
    ]);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${Z}/volumes/sbs-1`)).toBe(false);
  });

  it("does not take an Instance API 404 on a volume of unknown type for a deletion", async () => {
    // Older rows only know the volume ids; the instance is already gone.
    const { impl, calls } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\/srv-3$/, () => ({ status: 404, body: { type: "not_found" } })],
      [/^DELETE .*\/instance\/v1\/zones\/fr-par-1\/volumes\/vol-x$/, () => ({ status: 404, body: { type: "not_found" } })],
      [/^GET \/block\/v1\/zones\/fr-par-1\/volumes\/vol-x$/, () => ({ status: 200, body: { id: "vol-x", status: "available" } })],
      [/^DELETE \/block\/v1\/zones\/fr-par-1\/volumes\/vol-x$/, () => ({ status: 204 })],
      [/^DELETE .*\/ips\/ip-3$/, () => ({ status: 204 })],
    ]); // prettier-ignore
    await new ScalewayProvider(CREDS, impl).deleteServer("srv-3", "fr-par-1", {
      ipId: "ip-3",
      volumeIds: ["vol-x"],
    });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `${Z}/volumes/vol-x`,
      "/block/v1/zones/fr-par-1/volumes/vol-x",
      `${Z}/ips/ip-3`,
    ]);
  });

  it("is idempotent: everything already gone is fine", async () => {
    const { impl } = fakeFetch([
      [/^GET \/instance\/v1\/zones\/fr-par-1\/servers\/srv-4$/, () => ({ status: 404, body: {} })],
      [/^DELETE .*\/instance\/v1\/zones\/fr-par-1\/volumes\/v4$/, () => ({ status: 404, body: {} })],
      [/^GET \/block\/v1\/zones\/fr-par-1\/volumes\/v4$/, () => ({ status: 404, body: {} })],
      [/^DELETE .*\/ips\/ip-4$/, () => ({ status: 404, body: {} })],
    ]); // prettier-ignore
    await expect(
      new ScalewayProvider(CREDS, impl).deleteServer("srv-4", "fr-par-1", {
        ipId: "ip-4",
        volumeIds: ["v4"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ScalewayProvider credentials", () => {
  it("never leaks a secret key pasted with an inner newline", async () => {
    let fetched = false;
    const secret = "11111111-2222-3333-4444-555555555555";
    const p = new ScalewayProvider({ secretKey: `${secret}\nx`, projectId: "p" }, async () => {
      fetched = true;
      return new Response("{}");
    });
    const err = await p.getServer("s", "fr-par-1").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/retour à la ligne/);
    expect((err as Error).message).not.toContain(secret);
    expect(fetched).toBe(false);
  });

  it("warns when Block Storage is not allowed", async () => {
    const { impl } = fakeFetch([
      ...catalogRoutes(),
      [/^GET \/account\/v3\/projects\/proj-1$/, () => ({ status: 200, body: { name: "AUSCII" } })],
      [/^GET \/block\/v1\/zones\/fr-par-1\/volumes\?/, () => ({ status: 403, body: { type: "permissions_denied" } })],
    ]); // prettier-ignore
    const me = await new ScalewayProvider(CREDS, impl).whoAmI("fr-par-1");
    expect(me.project).toBe("AUSCII");
    expect(me.warning).toMatch(/BlockStorageFullAccess/);
  });
});
