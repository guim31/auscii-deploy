import type { Server } from "@prisma/client";
import { prisma } from "../../db";
import { pickServer, type CandidateServer } from "../../capacity";
import type { ServerMetrics, ServerRef } from "../../providers/types";
import type { Settings } from "../../settings";
import type { Logger } from "../log";
import type { Providers } from "../../providers";
import { cloudInitFor } from "../../deploy/bootstrap";

export function serverRef(server: Server): ServerRef {
  return {
    id: server.id,
    name: server.name,
    ip: server.ip,
    sshUser: server.sshUser,
    vcpus: server.vcpus,
  };
}

/** Site statuses that occupy a server (a draft only reserves a name). */
export const HOSTED_SITE_STATUSES = ["provisioning", "ready", "preview", "live", "error"] as const;

export async function listCandidates(demo: boolean): Promise<CandidateServer[]> {
  const servers = await prisma.server.findMany({
    where: { isDemo: demo, status: { notIn: ["retired", "retiring"] } },
    include: {
      _count: {
        select: {
          sites: { where: { status: { in: [...HOSTED_SITE_STATUSES] } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    // A server the hourly check cannot reach must not receive new sites.
    status: s.status === "ready" && s.unreachableSince ? "unreachable" : s.status,
    vcpus: s.vcpus,
    metrics: (s.metrics as ServerMetrics | null) ?? null,
    sitesCount: s._count.sites,
  }));
}

/** First free "vps-NN" (or "demo-NN") name; names typed by hand are skipped. */
export async function nextServerName(demo: boolean): Promise<string> {
  const prefix = demo ? "demo" : "vps";
  const taken = new Set(
    (
      await prisma.server.findMany({
        where: { name: { startsWith: `${prefix}-` } },
        select: { name: true },
      })
    ).map((s) => s.name),
  );
  for (let i = 1; i < 1000; i++) {
    const name = `${prefix}-${String(i).padStart(2, "0")}`;
    if (!taken.has(name)) return name;
  }
  throw new Error("Impossible de nommer le nouveau serveur");
}

function cloudInit(settings: Settings) {
  return cloudInitFor({
    sshPublicKey: settings.sshPublicKey || "(clé du pilote non générée)",
    acmeEmail: settings.gandiContact.email || `admin@${settings.techDomain}`,
  });
}

export type OrderOptions = {
  /** Offer to order; the configured default otherwise. Never substituted. */
  offerId?: string;
  /** Monthly price the admin confirmed: the order is refused above it. */
  maxMonthlyPrice?: number | null;
  /** Admin who confirmed the order, for the audit log. */
  confirmedById?: string | null;
  /** Called with the new row before anything is ordered, e.g. to attach it to the site. */
  onRow?: (server: Server) => Promise<void>;
};

/**
 * Creates the Server row, then orders the instance. The row exists before the
 * provider call and receives the provider id as soon as the instance exists
 * (onCreated hook): a failure at any point leaves a row the next attempt
 * resumes (resumeOrder) instead of ordering a second, billed instance.
 */
export async function orderServer(
  providers: Providers,
  settings: Settings,
  log: Logger,
  opts: OrderOptions = {},
): Promise<Server> {
  if (!providers.demo && !settings.sshPublicKey) {
    throw new Error(
      "Générez d'abord la clé SSH du pilote (Paramètres > Intégrations > SSH) : elle doit être installée sur le serveur commandé.",
    );
  }
  const offerId = opts.offerId ?? settings.defaultOffer;
  const offers = await providers.cloud.listOffers(settings.defaultZone);
  const offer = offers.find((o) => o.id === offerId);
  if (!offer)
    throw new Error(
      `L'offre ${offerId} n'est pas disponible en ${settings.defaultZone}. Choisissez une autre offre dans Paramètres > Agence ; rien n'a été commandé.`,
    );
  if (opts.maxMonthlyPrice != null && offer.monthlyPrice > opts.maxMonthlyPrice + 0.01)
    throw new Error(
      `Le prix de l'offre ${offer.id} est passé à ${offer.monthlyPrice.toFixed(2)} €/mois (${opts.maxMonthlyPrice.toFixed(2)} € confirmés). Un administrateur doit confirmer à nouveau ; rien n'a été commandé.`,
    );
  const name = await nextServerName(providers.demo);
  const row = await prisma.server.create({
    data: {
      name,
      provider: providers.demo ? "mock" : "scaleway",
      status: "ordering",
      offer: offer.id,
      zone: settings.defaultZone,
      vcpus: offer.vcpus,
      monthlyPrice: offer.monthlyPrice,
      isDemo: providers.demo,
    },
  });
  await opts.onRow?.(row);
  await log.info(
    `Commande d'un serveur ${offer.id} (${offer.vcpus} vCPU, ${offer.ramGb} Go, ${offer.monthlyPrice.toFixed(2)} €/mois) en ${settings.defaultZone}`,
  );
  const ordered = await placeOrder(row, providers, settings, log);
  await prisma.auditLog.create({
    data: {
      userId: opts.confirmedById ?? null,
      action: "server.ordered",
      target: ordered.name,
      amount: offer.monthlyPrice,
      currency: offer.currency,
      details: { providerId: ordered.providerId, offer: offer.id, zone: ordered.zone },
    },
  });
  return ordered;
}

async function placeOrder(
  row: Server,
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<Server> {
  const created = await providers.cloud.createServer(
    { name: row.name, offer: row.offer, zone: row.zone, cloudInit: cloudInit(settings) },
    {
      onCreated: async (c) => {
        await prisma.server.update({
          where: { id: row.id },
          data: {
            providerId: c.providerId,
            ip: c.ip ?? null,
            providerData: (c.metadata as object | undefined) ?? undefined,
            status: "bootstrapping",
          },
        });
      },
    },
  );
  await log.info(`Instance ${created.providerId} créée, démarrage en cours`);
  return prisma.server.update({
    where: { id: row.id },
    data: {
      providerId: created.providerId,
      ip: created.ip ?? undefined,
      providerData: (created.metadata as object | undefined) ?? undefined,
      status: "bootstrapping",
    },
  });
}

/**
 * Resumes a server row left in "ordering" by an interrupted attempt: adopts the
 * instance if the provider has it, otherwise places the order again.
 */
export async function resumeOrder(
  server: Server,
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<Server> {
  if (server.providerId) return server;
  const found = await providers.cloud.findServerByName(server.name, server.zone);
  if (found) {
    await log.info(`Instance ${found.providerId} retrouvée chez le fournisseur, reprise`);
    return prisma.server.update({
      where: { id: server.id },
      data: {
        providerId: found.providerId,
        ip: found.ip ?? null,
        providerData: (found.metadata as object | undefined) ?? undefined,
        status: "bootstrapping",
      },
    });
  }
  await log.warn(`La commande de ${server.name} n'a pas abouti : nouvelle tentative`);
  return placeOrder(server, providers, settings, log);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the instance to get an IP (cloud servers), then for SSH and Caddy.
 * The server only becomes "ready" if nobody retired it meanwhile.
 */
export async function bootstrapServer(
  server: Server,
  providers: Providers,
  log: Logger,
): Promise<Server> {
  if (server.status === "ready") return server;
  if (server.status === "retired" || server.status === "retiring")
    throw new Error(`Le serveur ${server.name} a été retiré`);
  let ip = server.ip;
  if (!ip) {
    if (!server.providerId)
      throw new Error(`Serveur ${server.name} sans adresse IP ni identifiant fournisseur`);
    for (let i = 0; i < 60 && !ip; i++) {
      if (i > 0) await sleep(providers.demo ? 200 : 5000);
      const remote = await providers.cloud.getServer(server.providerId, server.zone);
      if (remote.state === "error")
        throw new Error(`Le fournisseur signale une erreur sur ${server.name}`);
      if (remote.state === "running" && remote.ip) ip = remote.ip;
      else if (i % 6 === 0) await log.info(`Instance ${remote.state}, nouvelle vérification…`);
    }
    if (!ip) throw new Error(`Le serveur ${server.name} n'a pas obtenu d'adresse IP à temps`);
    await log.info(`Adresse IP ${ip} attribuée.`);
  }
  const moved = await prisma.server.updateMany({
    where: { id: server.id, status: { in: ["ordering", "bootstrapping", "error"] } },
    data: { ip, status: "bootstrapping" },
  });
  if (moved.count === 0) throw new Error(`Le serveur ${server.name} a été retiré`);
  const withIp = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
  await log.info(`Attente de SSH et de Caddy sur ${ip} (script d'installation)…`);
  await providers.agent.waitReady(serverRef(withIp), 10 * 60 * 1000);
  const metrics = await providers.agent.collectMetrics(serverRef(withIp));
  const ready = await prisma.server.updateMany({
    where: { id: server.id, status: "bootstrapping" },
    data: { status: "ready", metrics, lastError: null, unreachableSince: null },
  });
  if (ready.count === 0)
    throw new Error(`Le serveur ${server.name} a été retiré pendant son installation`);
  await log.success(`Serveur ${withIp.name} prêt`);
  return prisma.server.findUniqueOrThrow({ where: { id: server.id } });
}

export type PlacementResult =
  | { kind: "existing"; server: Server }
  | {
      kind: "new-server";
      offerPrice: number | null;
      offerId: string;
      reasons: string[];
      /** Why no price could be obtained (provider not configured, offer missing…). */
      offerError: string | null;
    };

/** Chooses where a site goes, without ordering anything. Used by the wizard to show the plan. */
export async function planPlacement(
  providers: Providers,
  settings: Settings,
  zipBytes: number,
): Promise<PlacementResult> {
  const candidates = await listCandidates(providers.demo);
  const placement = pickServer(candidates, zipBytes, settings.capacity);
  if (placement.kind === "existing") {
    const server = await prisma.server.findUniqueOrThrow({ where: { id: placement.server.id } });
    return { kind: "existing", server };
  }
  let offerPrice: number | null = null;
  let offerError: string | null = null;
  try {
    const offers = await providers.cloud.listOffers(settings.defaultZone);
    offerPrice = offers.find((o) => o.id === settings.defaultOffer)?.monthlyPrice ?? null;
    if (offerPrice === null)
      offerError = `L'offre ${settings.defaultOffer} n'est pas disponible en ${settings.defaultZone}.`;
  } catch (err) {
    offerError = err instanceof Error ? err.message : "Offres indisponibles";
  }
  const reasons = placement.verdicts.flatMap((v) => v.reasons);
  return { kind: "new-server", offerPrice, offerId: settings.defaultOffer, reasons, offerError };
}
