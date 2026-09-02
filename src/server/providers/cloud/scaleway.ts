import type { CloudProvider, CloudServer, ServerOffer } from "../types";
import { ProviderNotConfiguredError } from "../types";
import { ScalewayClient, ScalewayError, type FetchLike } from "./scaleway-client";

export type ScalewayCredentials = { secretKey: string; projectId: string; defaultZone?: string };

export type ScalewayServerMetadata = { ipId?: string; volumeIds?: string[] };

type ProductsResponse = {
  servers: Record<
    string,
    {
      ncpus: number;
      ram: number;
      hourly_price: number;
      arch?: string;
      volumes_constraint?: { min_size: number; max_size: number };
      per_volume_constraint?: { l_ssd?: { min_size: number; max_size: number } };
    }
  >;
};
type AvailabilityResponse = {
  servers: Record<string, { availability: "available" | "scarce" | "shortage" }>;
};
type LocalImagesResponse = { local_images: { id: string; zone: string; type?: string }[] };
type IpResponse = { ip: { id: string; address: string } };
type ServerResponse = {
  server: {
    id: string;
    name: string;
    state: string;
    zone?: string;
    public_ip?: { id?: string; address?: string } | null;
    public_ips?: { id?: string; address?: string }[];
    volumes?: Record<string, { id: string }>;
  };
};

/** Instance families the tool orders: cheap shared vCPU offers with local or block storage. */
const FAMILIES = ["DEV1", "PLAY2", "PRO2"];
const HOURS_PER_MONTH = 730;

export function offersFromProducts(
  products: ProductsResponse,
  availability?: AvailabilityResponse,
): ServerOffer[] {
  return Object.entries(products.servers ?? {})
    .filter(([id]) => FAMILIES.some((f) => id.startsWith(`${f}-`)))
    .filter(([id]) => !availability || availability.servers?.[id]?.availability !== "shortage")
    .map(([id, p]) => {
      const disk = p.per_volume_constraint?.l_ssd?.max_size ?? p.volumes_constraint?.min_size ?? 0;
      return {
        id,
        vcpus: p.ncpus,
        ramGb: Math.round(p.ram / 1024 ** 3),
        diskGb: Math.round(disk / 1e9),
        monthlyPrice: Math.round(p.hourly_price * HOURS_PER_MONTH * 100) / 100,
        currency: "EUR",
      };
    })
    .sort((a, b) => a.monthlyPrice - b.monthlyPrice);
}

export function stateFromScaleway(state: string): CloudServer["state"] {
  if (state === "running") return "running";
  if (state === "stopped" || state === "stopped in place") return "stopped";
  if (state === "locked") return "error";
  return "starting";
}

function usesLocalStorage(offer: string): boolean {
  return offer.startsWith("DEV1-");
}

/** Real Scaleway Instances implementation. */
export class ScalewayProvider implements CloudProvider {
  readonly name = "scaleway";
  private readonly client: ScalewayClient | null;

  constructor(
    private readonly creds: ScalewayCredentials | null,
    fetchImpl?: FetchLike,
  ) {
    this.client = creds?.secretKey ? new ScalewayClient(creds.secretKey, fetchImpl) : null;
  }

  private api(): ScalewayClient {
    if (!this.client || !this.creds?.projectId) {
      throw new ProviderNotConfiguredError(
        "Scaleway",
        "Clé API et identifiant de projet Scaleway requis (Paramètres > Intégrations).",
      );
    }
    return this.client;
  }

  private base(zone: string): string {
    return `/instance/v1/zones/${encodeURIComponent(zone)}`;
  }

  async listOffers(zone: string): Promise<ServerOffer[]> {
    const api = this.api();
    const products = (
      await api.request<ProductsResponse>("GET", `${this.base(zone)}/products/servers?per_page=100`)
    ).data;
    let availability: AvailabilityResponse | undefined;
    try {
      availability = (
        await api.request<AvailabilityResponse>(
          "GET",
          `${this.base(zone)}/products/servers/availability?per_page=100`,
        )
      ).data;
    } catch {
      availability = undefined;
    }
    return offersFromProducts(products, availability);
  }

  private async debianImage(zone: string, offer: string): Promise<string> {
    const type = usesLocalStorage(offer) ? "instance_local" : "instance_sbs";
    const { data } = await this.api().request<LocalImagesResponse>(
      "GET",
      `/marketplace/v2/local-images?image_label=debian_bookworm&zone=${encodeURIComponent(zone)}&type=${type}&per_page=10`,
    );
    const image = data.local_images?.find((i) => i.zone === zone) ?? data.local_images?.[0];
    if (!image) throw new Error(`Image Debian 12 introuvable dans la zone ${zone}`);
    return image.id;
  }

  async createServer(input: {
    name: string;
    offer: string;
    zone: string;
    cloudInit: string;
  }): Promise<CloudServer> {
    const api = this.api();
    const base = this.base(input.zone);
    const image = await this.debianImage(input.zone, input.offer);
    const ip = (
      await api.request<IpResponse>("POST", `${base}/ips`, {
        body: { project: this.creds!.projectId, type: "routed_ipv4" },
      })
    ).data.ip;
    let server: ServerResponse["server"];
    try {
      server = (
        await api.request<ServerResponse>("POST", `${base}/servers`, {
          body: {
            name: input.name,
            commercial_type: input.offer,
            image,
            project: this.creds!.projectId,
            public_ips: [ip.id],
            tags: ["auscii-deploy"],
          },
        })
      ).data.server;
    } catch (err) {
      await api
        .request("DELETE", `${base}/ips/${ip.id}`, { expect: [204, 404] })
        .catch(() => undefined);
      throw err;
    }
    await api.request("PATCH", `${base}/servers/${server.id}/user_data/cloud-init`, {
      rawBody: input.cloudInit,
      contentType: "text/plain",
    });
    await api.request("POST", `${base}/servers/${server.id}/action`, {
      body: { action: "poweron" },
    });
    const volumeIds = Object.values(server.volumes ?? {}).map((v) => v.id);
    return {
      providerId: server.id,
      name: server.name,
      zone: input.zone,
      state: "starting",
      ip: ip.address,
      metadata: { ipId: ip.id, volumeIds } satisfies ScalewayServerMetadata,
    };
  }

  async getServer(providerId: string, zone: string): Promise<CloudServer> {
    const { data } = await this.api().request<ServerResponse>(
      "GET",
      `${this.base(zone)}/servers/${encodeURIComponent(providerId)}`,
    );
    const s = data.server;
    const ip = s.public_ip?.address ?? s.public_ips?.[0]?.address;
    return {
      providerId: s.id,
      name: s.name,
      zone,
      state: stateFromScaleway(s.state),
      ip: ip ?? undefined,
    };
  }

  /** Removes the instance, then its volumes and IP. Missing resources are ignored so a retry is safe. */
  async deleteServer(
    providerId: string,
    zone: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const api = this.api();
    const base = this.base(zone);
    const meta = (metadata ?? {}) as ScalewayServerMetadata;
    let current: ServerResponse["server"] | null = null;
    try {
      current = (await api.request<ServerResponse>("GET", `${base}/servers/${providerId}`)).data
        .server;
    } catch (err) {
      if (!(err instanceof ScalewayError && err.status === 404)) throw err;
    }
    if (current) {
      const volumeIds = new Set([
        ...(meta.volumeIds ?? []),
        ...Object.values(current.volumes ?? {}).map((v) => v.id),
      ]);
      const ipId = meta.ipId ?? current.public_ip?.id ?? current.public_ips?.[0]?.id;
      if (current.state !== "stopped") {
        await api.request("POST", `${base}/servers/${providerId}/action`, {
          body: { action: "poweroff" },
          expect: [200, 202, 400],
        });
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 0 : 5000));
          const s = (await api.request<ServerResponse>("GET", `${base}/servers/${providerId}`)).data
            .server;
          if (s.state === "stopped") break;
        }
      }
      await api.request("DELETE", `${base}/servers/${providerId}`, { expect: [204, 404] });
      for (const id of volumeIds)
        await api.request("DELETE", `${base}/volumes/${id}`, { expect: [204, 404] });
      if (ipId) await api.request("DELETE", `${base}/ips/${ipId}`, { expect: [204, 404] });
      return;
    }
    for (const id of meta.volumeIds ?? [])
      await api.request("DELETE", `${base}/volumes/${id}`, { expect: [204, 404] });
    if (meta.ipId) await api.request("DELETE", `${base}/ips/${meta.ipId}`, { expect: [204, 404] });
  }

  /** Used by the settings "Tester" button: validates the key, the zone and the project. */
  async whoAmI(
    zone: string,
  ): Promise<{ offers: number; project: string | null; warning?: string }> {
    const offers = await this.listOffers(zone);
    try {
      const { data } = await this.api().request<{ name?: string; id?: string }>(
        "GET",
        `/account/v3/projects/${this.creds!.projectId}`,
      );
      return { offers: offers.length, project: data.name ?? data.id ?? this.creds!.projectId };
    } catch (err) {
      if (err instanceof ScalewayError && (err.status === 403 || err.status === 404)) {
        return {
          offers: offers.length,
          project: null,
          warning:
            "Le projet n'a pas pu être vérifié (permission ProjectManager absente). La clé fonctionne pour les instances.",
        };
      }
      throw err;
    }
  }
}
