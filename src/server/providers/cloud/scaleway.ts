import type { CloudProvider, CloudServer, ServerOffer } from "../types";
import { ProviderNotConfiguredError, ServerOrderIncompleteError } from "../types";
import { cleanSecret } from "../http-utils";
import { ScalewayClient, ScalewayError, type FetchLike } from "./scaleway-client";

export type ScalewayCredentials = { secretKey: string; projectId: string; defaultZone?: string };

export type ScalewayVolumeType = "l_ssd" | "sbs_volume";

/**
 * Kept on the Server row (providerData) for deletion. `volumeIds` alone comes
 * from older rows: their type is then found at deletion time.
 */
export type ScalewayServerMetadata = {
  ipId?: string;
  volumeIds?: string[];
  volumes?: { id: string; type?: string }[];
};

/** Instance type, as returned by GET /instance/v1/zones/{zone}/products/servers (scaleway-sdk-go ServerType). */
type ProductServer = {
  ncpus: number;
  ram: number;
  hourly_price: number;
  /** Deprecated by Scaleway but still returned: estimated price for a 30-day month. */
  monthly_price?: number | null;
  arch?: string;
  end_of_service?: boolean;
  volumes_constraint?: { min_size: number; max_size: number } | null;
  per_volume_constraint?: { l_ssd?: { min_size: number; max_size: number } | null } | null;
};
type ProductsResponse = { servers: Record<string, ProductServer>; total_count?: number };
type AvailabilityResponse = {
  servers: Record<string, { availability: "available" | "scarce" | "shortage" }>;
  total_count?: number;
};
type LocalImage = {
  id: string;
  zone: string;
  arch?: string;
  type?: string;
  compatible_commercial_types?: string[];
};
type LocalImagesResponse = { local_images: LocalImage[]; total_count?: number };
type Money = { currency_code?: string; units?: number; nanos?: number };
type BlockVolumeTypesResponse = { volume_types?: { type: string; pricing?: Money | null }[] };
type BlockVolume = { id: string; status?: string };
type ApiIp = { id: string; address: string; server?: { id: string } | null; tags?: string[] };
type IpResponse = { ip: ApiIp };
type ApiServer = {
  id: string;
  name: string;
  state: string;
  commercial_type?: string;
  zone?: string;
  tags?: string[];
  public_ip?: { id?: string; address?: string } | null;
  public_ips?: { id?: string; address?: string }[];
  volumes?: Record<string, { id: string; volume_type?: string }>;
};
type ServerResponse = { server: ApiServer };
type ServersResponse = { servers: ApiServer[]; total_count?: number };

/** Instance families the tool orders: cheap shared vCPU offers with local or block storage. */
const FAMILIES = ["DEV1", "PLAY2", "PRO2"];
const HOURS_PER_MONTH = 730;
/** Tag put on every instance and IP the tool orders, to find them again. */
export const TOOL_TAG = "auscii-deploy";
/** Root volume of block-storage offers (PLAY2, PRO2): enough for Debian, Caddy and many static sites. */
export const SBS_ROOT_GB = 20;
/** Block storage class created by default for an `sbs_volume` root volume (not confirmed, used for the price estimate only). */
const DEFAULT_SBS_CLASS = "sbs_5k";
/**
 * Price of a routed IPv4 in €/hour before taxes. The API exposes no price for
 * IPs: this is Scaleway's public price list (0.004 €/h), to check with the
 * first invoice.
 */
export const ROUTED_IPV4_HOURLY_EUR = 0.004;
const GB = 1e9;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function familyOf(id: string): string {
  return id.split("-")[0];
}

/** Local SSD for DEV1 (its price includes the disk), block storage otherwise. */
export function storageFor(id: string, p: ProductServer): ScalewayVolumeType {
  if (familyOf(id) === "DEV1") return "l_ssd";
  if ((p.volumes_constraint?.min_size ?? 0) > 0) return "l_ssd";
  return "sbs_volume";
}

/**
 * Root volume for an offer, within `volumes_constraint`: DEV1-S requires
 * exactly 20 GB of local SSD, DEV1-M 40 GB…; block offers get SBS_ROOT_GB.
 */
export function rootVolumeFor(
  id: string,
  p: ProductServer,
): { size: number; volume_type: ScalewayVolumeType } {
  const type = storageFor(id, p);
  if (type === "sbs_volume") return { size: SBS_ROOT_GB * GB, volume_type: type };
  const total = p.volumes_constraint?.max_size ?? 0;
  const perVolume = p.per_volume_constraint?.l_ssd?.max_size ?? 0;
  const candidates = [total, perVolume].filter((n) => n > 0);
  let size = candidates.length ? Math.min(...candidates) : SBS_ROOT_GB * GB;
  size = Math.max(size, p.volumes_constraint?.min_size ?? 0);
  // Sizes must be multiples of 512 bytes.
  return { size: Math.floor(size / 512) * 512, volume_type: type };
}

export type OfferPricing = {
  /** Block storage price in €/GB/hour, when the Block API could be read. */
  sbsPerGbHour?: number;
  /** Monthly price of the public IPv4. */
  ipv4Monthly?: number;
};

/** Why an offer cannot be ordered in the zone, or null when it can. */
export function offerUnavailableReason(
  id: string,
  products: ProductsResponse,
  availability?: AvailabilityResponse,
): string | null {
  const p = products.servers?.[id];
  if (!p) return "offre inconnue dans cette zone";
  if (p.end_of_service) return "offre en fin de vente chez Scaleway";
  if (availability?.servers?.[id]?.availability === "shortage")
    return "offre en rupture de stock dans cette zone";
  return null;
}

export function offersFromProducts(
  products: ProductsResponse,
  availability?: AvailabilityResponse,
  pricing: OfferPricing = {},
): ServerOffer[] {
  return Object.entries(products.servers ?? {})
    .filter(([id]) => FAMILIES.includes(familyOf(id)))
    .filter(([id]) => offerUnavailableReason(id, products, availability) === null)
    .map(([id, p]) => {
      const root = rootVolumeFor(id, p);
      const instance = round2(
        typeof p.monthly_price === "number" && p.monthly_price > 0
          ? p.monthly_price
          : p.hourly_price * HOURS_PER_MONTH,
      );
      const volume =
        root.volume_type === "sbs_volume" && pricing.sbsPerGbHour !== undefined
          ? round2((root.size / GB) * pricing.sbsPerGbHour * HOURS_PER_MONTH)
          : undefined;
      const ipv4 = pricing.ipv4Monthly !== undefined ? round2(pricing.ipv4Monthly) : undefined;
      return {
        id,
        vcpus: p.ncpus,
        ramGb: Math.round(p.ram / 1024 ** 3),
        diskGb: Math.round(root.size / GB),
        monthlyPrice: round2(instance + (ipv4 ?? 0) + (volume ?? 0)),
        currency: "EUR",
        priceBreakdown: { instance, ipv4, volume },
        arch: p.arch,
        storage: root.volume_type,
      } satisfies ServerOffer;
    })
    .sort((a, b) => a.monthlyPrice - b.monthlyPrice);
}

/** Picks the Debian 12 image matching the offer: same zone, same architecture, declared compatible. */
export function pickImage(
  images: LocalImage[],
  zone: string,
  offer: string,
  arch: string | undefined,
): LocalImage | undefined {
  return images.find(
    (i) =>
      i.zone === zone &&
      (!arch || !i.arch || i.arch === arch) &&
      (i.compatible_commercial_types ?? [])
        .map((t) => t.toUpperCase())
        .includes(offer.toUpperCase()),
  );
}

export function moneyToNumber(m: Money | null | undefined): number | undefined {
  if (!m) return undefined;
  return (m.units ?? 0) + (m.nanos ?? 0) / 1e9;
}

export function stateFromScaleway(state: string): CloudServer["state"] {
  if (state === "running") return "running";
  if (state === "stopped" || state === "stopped in place") return "stopped";
  if (state === "locked") return "error";
  return "starting";
}

function metadataOf(server: ApiServer, ipId?: string): ScalewayServerMetadata {
  const volumes = Object.values(server.volumes ?? {}).map((v) => ({
    id: v.id,
    type: v.volume_type,
  }));
  return {
    ipId: ipId ?? server.public_ip?.id ?? server.public_ips?.[0]?.id,
    volumeIds: volumes.map((v) => v.id),
    volumes,
  };
}

function toCloudServer(server: ApiServer, zone: string, ip?: ApiIp): CloudServer {
  const address = ip?.address ?? server.public_ip?.address ?? server.public_ips?.[0]?.address;
  return {
    providerId: server.id,
    name: server.name,
    zone,
    state: stateFromScaleway(server.state),
    ip: address ?? undefined,
    metadata: metadataOf(server, ip?.id),
  };
}

function pollDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 0 : ms));
}

/** Real Scaleway Instances implementation (plus Block Storage for the root volumes of PLAY2/PRO2). */
export class ScalewayProvider implements CloudProvider {
  readonly name = "scaleway";
  private readonly client: ScalewayClient | null;
  private readonly projectId: string;

  constructor(creds: ScalewayCredentials | null, fetchImpl?: FetchLike) {
    const secretKey = cleanSecret(creds?.secretKey);
    this.projectId = cleanSecret(creds?.projectId);
    this.client = secretKey ? new ScalewayClient(secretKey, fetchImpl) : null;
  }

  private api(): ScalewayClient {
    if (!this.client || !this.projectId) {
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

  /** Reads every page of a Scaleway list (`total_count` in the body, or X-Total-Count). */
  private async allPages<T extends { total_count?: number }>(
    path: string,
    count: (page: T) => number,
    merge: (acc: T | null, page: T) => T,
    pageParam: "per_page" | "page_size" = "per_page",
  ): Promise<T> {
    let acc: T | null = null;
    let seen = 0;
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const { data, headers } = await this.api().request<T>(
        "GET",
        `${path}${sep}${pageParam}=100&page=${page}`,
      );
      acc = merge(acc, data);
      const n = count(data);
      seen += n;
      const total = Number(data?.total_count ?? headers.get("x-total-count") ?? 0);
      if (n === 0 || !total || seen >= total) break;
    }
    return acc!;
  }

  private async products(zone: string): Promise<ProductsResponse> {
    return this.allPages<ProductsResponse>(
      `${this.base(zone)}/products/servers`,
      (p) => Object.keys(p?.servers ?? {}).length,
      (acc, p) => ({
        servers: { ...(acc?.servers ?? {}), ...(p?.servers ?? {}) },
        total_count: p?.total_count,
      }),
    );
  }

  private async availability(zone: string): Promise<AvailabilityResponse | undefined> {
    try {
      return await this.allPages<AvailabilityResponse>(
        `${this.base(zone)}/products/servers/availability`,
        (p) => Object.keys(p?.servers ?? {}).length,
        (acc, p) => ({
          servers: { ...(acc?.servers ?? {}), ...(p?.servers ?? {}) },
          total_count: p?.total_count,
        }),
      );
    } catch {
      return undefined;
    }
  }

  /** Block storage price per GB/hour, best effort (needs a Block Storage read permission). */
  private async sbsPricing(zone: string): Promise<number | undefined> {
    try {
      const { data } = await this.api().request<BlockVolumeTypesResponse>(
        "GET",
        `/block/v1/zones/${encodeURIComponent(zone)}/volume-types`,
      );
      const types = (data?.volume_types ?? [])
        .map((t) => ({ type: t.type, price: moneyToNumber(t.pricing) }))
        .filter((t): t is { type: string; price: number } => t.price !== undefined);
      const preferred = types.find((t) => t.type === DEFAULT_SBS_CLASS);
      if (preferred) return preferred.price;
      return types.length ? Math.min(...types.map((t) => t.price)) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Offers of the zone that can be ordered now (no end of service, no
   * shortage). The price includes the IPv4 and, for block offers, the root
   * volume when the Block API could be read (see priceBreakdown).
   */
  async listOffers(zone: string): Promise<ServerOffer[]> {
    const [products, availability, sbsPerGbHour] = await Promise.all([
      this.products(zone),
      this.availability(zone),
      this.sbsPricing(zone),
    ]);
    return offersFromProducts(products, availability, {
      sbsPerGbHour,
      ipv4Monthly: ROUTED_IPV4_HOURLY_EUR * HOURS_PER_MONTH,
    });
  }

  private async debianImage(
    zone: string,
    offer: string,
    arch: string | undefined,
    volumeType: ScalewayVolumeType,
  ): Promise<string> {
    const type = volumeType === "l_ssd" ? "instance_local" : "instance_sbs";
    const params = new URLSearchParams({ image_label: "debian_bookworm", zone, type });
    if (arch) params.set("arch", arch);
    const data = await this.allPages<LocalImagesResponse>(
      `/marketplace/v2/local-images?${params.toString()}`,
      (p) => p?.local_images?.length ?? 0,
      (acc, p) => ({
        local_images: [...(acc?.local_images ?? []), ...(p?.local_images ?? [])],
        total_count: p?.total_count,
      }),
      "page_size",
    );
    const image = pickImage(data.local_images ?? [], zone, offer, arch);
    if (!image)
      throw new Error(
        `Image Debian 12 introuvable pour ${offer} (${arch ?? "architecture inconnue"}) dans la zone ${zone}`,
      );
    return image.id;
  }

  /** The instance with this exact name created by the tool, if any. */
  async findServerByName(name: string, zone: string): Promise<CloudServer | null> {
    const found = await this.findApiServer(name, zone);
    return found ? toCloudServer(found, zone) : null;
  }

  private async findApiServer(name: string, zone: string): Promise<ApiServer | null> {
    const params = new URLSearchParams({ name, tags: TOOL_TAG, project: this.projectId });
    const data = await this.allPages<ServersResponse>(
      `${this.base(zone)}/servers?${params.toString()}`,
      (p) => p?.servers?.length ?? 0,
      (acc, p) => ({
        servers: [...(acc?.servers ?? []), ...(p?.servers ?? [])],
        total_count: p?.total_count,
      }),
    );
    // The API filters by substring ("vps-1" also matches "vps-10"): keep exact names.
    const matches = (data.servers ?? []).filter(
      (s) => s.name === name && (s.tags ?? []).includes(TOOL_TAG),
    );
    if (matches.length > 1)
      throw new Error(
        `Plusieurs instances Scaleway s'appellent ${name} (${matches.map((s) => s.id).join(", ")}) : supprimez les doublons dans la console avant de continuer.`,
      );
    return matches[0] ?? null;
  }

  /** A routed IPv4 left by an interrupted order of this server, not attached to anything. */
  private async orphanIp(name: string, zone: string): Promise<ApiIp | null> {
    try {
      const params = new URLSearchParams({ tags: `${TOOL_TAG}:${name}`, project: this.projectId });
      const { data } = await this.api().request<{ ips?: ApiIp[] }>(
        "GET",
        `${this.base(zone)}/ips?${params.toString()}&per_page=50`,
      );
      return (data?.ips ?? []).find((ip) => !ip.server) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Orders exactly `offer` (never a substitute). The instance is created
   * stopped, reported through `onCreated`, then receives cloud-init and is
   * powered on. An interrupted order is resumed: an instance with the same
   * name is adopted instead of ordering a second one, and its routed IP is
   * reused.
   */
  async createServer(
    input: { name: string; offer: string; zone: string; cloudInit: string },
    hooks: { onCreated?: (server: CloudServer) => Promise<void> } = {},
  ): Promise<CloudServer> {
    const api = this.api();
    const base = this.base(input.zone);

    const existing = await this.findApiServer(input.name, input.zone);
    if (existing) {
      if (existing.commercial_type && existing.commercial_type !== input.offer)
        throw new Error(
          `Une instance ${input.name} existe déjà chez Scaleway avec l'offre ${existing.commercial_type} (${existing.id}), et non ${input.offer} : vérifiez-la dans la console avant de recommander.`,
        );
      return this.finishOrder(existing, input, hooks, true);
    }

    const [products, availability] = await Promise.all([
      this.products(input.zone),
      this.availability(input.zone),
    ]);
    const unavailable = offerUnavailableReason(input.offer, products, availability);
    if (unavailable)
      throw new Error(
        `Impossible de commander ${input.offer} en ${input.zone} : ${unavailable}. Rien n'a été commandé ; choisissez une autre offre (Paramètres).`,
      );
    const product = products.servers[input.offer];
    const root = rootVolumeFor(input.offer, product);
    const image = await this.debianImage(input.zone, input.offer, product.arch, root.volume_type);

    const ip =
      (await this.orphanIp(input.name, input.zone)) ??
      (
        await api.request<IpResponse>("POST", `${base}/ips`, {
          body: {
            project: this.projectId,
            type: "routed_ipv4",
            tags: [TOOL_TAG, `${TOOL_TAG}:${input.name}`],
          },
        })
      ).data.ip;
    let server: ApiServer;
    try {
      server = (
        await api.request<ServerResponse>("POST", `${base}/servers`, {
          body: {
            name: input.name,
            commercial_type: input.offer,
            image,
            project: this.projectId,
            public_ips: [ip.id],
            tags: [TOOL_TAG],
            volumes: { "0": root },
          },
        })
      ).data.server;
    } catch (err) {
      await api
        .request("DELETE", `${base}/ips/${ip.id}`, { expect: [204, 404] })
        .catch(() => undefined);
      throw err;
    }
    return this.finishOrder(server, input, hooks, false, ip);
  }

  /** onCreated, cloud-init and power-on. Any failure keeps the instance id (ServerOrderIncompleteError). */
  private async finishOrder(
    server: ApiServer,
    input: { zone: string; cloudInit: string },
    hooks: { onCreated?: (server: CloudServer) => Promise<void> },
    adopted: boolean,
    ip?: ApiIp,
  ): Promise<CloudServer> {
    const api = this.api();
    const base = this.base(input.zone);
    const cloud = toCloudServer(server, input.zone, ip);
    try {
      await hooks.onCreated?.({ ...cloud });
      // A resumed instance that already booted has run cloud-init: leave it alone.
      const neverStarted = !adopted || server.state === "stopped";
      if (neverStarted) {
        await api.request("PATCH", `${base}/servers/${server.id}/user_data/cloud-init`, {
          rawBody: input.cloudInit,
          contentType: "text/plain",
        });
        await api.request("POST", `${base}/servers/${server.id}/action`, {
          body: { action: "poweron" },
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ServerOrderIncompleteError(
        `Instance ${server.id} créée chez Scaleway mais non démarrée : ${reason}`,
        cloud,
      );
    }
    return { ...cloud, state: "starting" };
  }

  async getServer(providerId: string, zone: string): Promise<CloudServer> {
    const { data } = await this.api().request<ServerResponse>(
      "GET",
      `${this.base(zone)}/servers/${encodeURIComponent(providerId)}`,
    );
    return toCloudServer(data.server, zone);
  }

  /**
   * Removes the instance, then its volumes and IP. Idempotent: resources
   * already gone are skipped. Block storage volumes (sbs_volume) are deleted
   * through the Block API once detached; a 404 of the Instance API on a
   * volume only means "not a local volume" and is checked there.
   */
  async deleteServer(
    providerId: string,
    zone: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const api = this.api();
    const base = this.base(zone);
    const meta = (metadata ?? {}) as ScalewayServerMetadata;
    let current: ApiServer | null = null;
    try {
      current = (await api.request<ServerResponse>("GET", `${base}/servers/${providerId}`)).data
        .server;
    } catch (err) {
      if (!(err instanceof ScalewayError && err.status === 404)) throw err;
    }
    const volumes = new Map<string, string | undefined>();
    for (const id of meta.volumeIds ?? []) volumes.set(id, undefined);
    for (const v of meta.volumes ?? []) volumes.set(v.id, v.type ?? volumes.get(v.id));
    for (const v of Object.values(current?.volumes ?? {}))
      volumes.set(v.id, v.volume_type ?? volumes.get(v.id));
    const ipId = meta.ipId ?? current?.public_ip?.id ?? current?.public_ips?.[0]?.id;

    if (current) {
      if (current.state !== "stopped") {
        await api.request("POST", `${base}/servers/${providerId}/action`, {
          body: { action: "poweroff" },
          expect: [200, 202, 400],
        });
        for (let i = 0; i < 60; i++) {
          await pollDelay(5000);
          const s = (await api.request<ServerResponse>("GET", `${base}/servers/${providerId}`)).data
            .server;
          if (s.state === "stopped") break;
        }
      }
      await api.request("DELETE", `${base}/servers/${providerId}`, { expect: [204, 404] });
    }
    for (const [id, type] of volumes) await this.deleteVolume(zone, id, type);
    if (ipId) await api.request("DELETE", `${base}/ips/${ipId}`, { expect: [204, 404] });
  }

  private async deleteVolume(zone: string, id: string, type: string | undefined): Promise<void> {
    if (type === "sbs_volume") return this.deleteBlockVolume(zone, id);
    const { status } = await this.api().request(
      "DELETE",
      `${this.base(zone)}/volumes/${encodeURIComponent(id)}`,
      { expect: [204, 404] },
    );
    // Unknown type and unknown to the Instance API: it may be a block volume.
    if (status === 404 && type === undefined) await this.deleteBlockVolume(zone, id);
  }

  /** Waits for the volume to be detached from the deleted instance, then deletes it. */
  private async deleteBlockVolume(zone: string, id: string): Promise<void> {
    const path = `/block/v1/zones/${encodeURIComponent(zone)}/volumes/${encodeURIComponent(id)}`;
    for (let i = 0; i < 60; i++) {
      let volume: BlockVolume;
      try {
        volume = (await this.api().request<BlockVolume>("GET", path)).data;
      } catch (err) {
        if (err instanceof ScalewayError && err.status === 404) return;
        throw err;
      }
      if (volume.status === "deleting" || volume.status === "deleted") return;
      if (volume.status === "available" || volume.status === "error") {
        await this.api().request("DELETE", path, { expect: [204, 404] });
        return;
      }
      // in_use (detaching after the instance deletion), creating, updating…
      await pollDelay(5000);
    }
    throw new Error(
      `Le volume ${id} n'a pas pu être supprimé (toujours attaché) : supprimez-le dans la console Scaleway (Block Storage), il reste facturé.`,
    );
  }

  /** Used by the settings "Tester" button: validates the key, the zone, the project and Block Storage access. */
  async whoAmI(
    zone: string,
  ): Promise<{ offers: number; project: string | null; warning?: string }> {
    const offers = await this.listOffers(zone);
    const warnings: string[] = [];
    let project: string | null = null;
    try {
      const { data } = await this.api().request<{ name?: string; id?: string }>(
        "GET",
        `/account/v3/projects/${this.projectId}`,
      );
      project = data.name ?? data.id ?? this.projectId;
    } catch (err) {
      if (!(err instanceof ScalewayError && (err.status === 403 || err.status === 404))) throw err;
      warnings.push(
        "Le projet n'a pas pu être vérifié (permission ProjectManager absente). La clé fonctionne pour les instances.",
      );
    }
    try {
      await this.api().request(
        "GET",
        `/block/v1/zones/${encodeURIComponent(zone)}/volumes?project_id=${encodeURIComponent(this.projectId)}&page_size=1`,
      );
    } catch (err) {
      if (!(err instanceof ScalewayError && (err.status === 401 || err.status === 403))) throw err;
      warnings.push(
        "Accès Block Storage refusé : ajoutez BlockStorageFullAccess, sinon les disques des offres PLAY2/PRO2 ne seront pas supprimés avec leur serveur.",
      );
    }
    return {
      offers: offers.length,
      project,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }
}
