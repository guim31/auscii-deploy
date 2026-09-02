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

export async function listCandidates(demo: boolean): Promise<CandidateServer[]> {
  const servers = await prisma.server.findMany({
    where: { isDemo: demo, status: { not: "retired" } },
    include: {
      _count: {
        select: {
          sites: { where: { status: { in: ["provisioning", "ready", "preview", "live"] } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    vcpus: s.vcpus,
    metrics: (s.metrics as ServerMetrics | null) ?? null,
    sitesCount: s._count.sites,
  }));
}

export async function nextServerName(demo: boolean): Promise<string> {
  const count = await prisma.server.count({ where: { isDemo: demo } });
  return `${demo ? "demo" : "vps"}-${String(count + 1).padStart(2, "0")}`;
}

/** Creates the Server row and orders it from the cloud provider. Returns the row in "ordering" state. */
export async function orderServer(
  providers: Providers,
  settings: Settings,
  log: Logger,
  offerId?: string,
): Promise<Server> {
  const offers = await providers.cloud.listOffers(settings.defaultZone);
  const offer = offers.find((o) => o.id === (offerId ?? settings.defaultOffer)) ?? offers[0];
  if (!offer) throw new Error("Aucune offre serveur disponible");
  const name = await nextServerName(providers.demo);
  await log.info(
    `Commande d'un serveur ${offer.id} (${offer.vcpus} vCPU, ${offer.ramGb} Go, ${offer.monthlyPrice.toFixed(2)} €/mois) en ${settings.defaultZone}`,
  );
  const server = await prisma.server.create({
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
  const created = await providers.cloud.createServer({
    name,
    offer: offer.id,
    zone: settings.defaultZone,
    cloudInit: cloudInitFor({
      sshPublicKey: settings.sshPublicKey || "(clé du pilote non générée)",
      acmeEmail: settings.gandiContact.email || `admin@${settings.techDomain}`,
    }),
  });
  await log.info(`Instance ${created.providerId} créée, démarrage en cours`);
  return prisma.server.update({
    where: { id: server.id },
    data: { providerId: created.providerId, status: "bootstrapping" },
  });
}

/** Waits for the instance to get an IP, then for SSH and Caddy. */
/** Waits for the instance to get an IP (cloud servers), then for SSH and Caddy. */
export async function bootstrapServer(
  server: Server,
  providers: Providers,
  log: Logger,
): Promise<Server> {
  if (server.status === "ready") return server;
  let ip = server.ip;
  if (!ip) {
    if (!server.providerId)
      throw new Error(`Serveur ${server.name} sans adresse IP ni identifiant fournisseur`);
    for (let i = 0; i < 60 && !ip; i++) {
      const remote = await providers.cloud.getServer(server.providerId, server.zone);
      if (remote.state === "error")
        throw new Error(`Le fournisseur signale une erreur sur ${server.name}`);
      if (remote.state === "running" && remote.ip) ip = remote.ip;
      else await log.info(`Instance ${remote.state}, nouvelle vérification…`);
    }
    if (!ip) throw new Error(`Le serveur ${server.name} n'a pas obtenu d'adresse IP à temps`);
    await log.info(`Adresse IP ${ip} attribuée.`);
  }
  const withIp = await prisma.server.update({
    where: { id: server.id },
    data: { ip, status: "bootstrapping" },
  });
  await log.info(`Attente de SSH et de Caddy sur ${ip} (script d'installation)…`);
  await providers.agent.waitReady(serverRef(withIp), 10 * 60 * 1000);
  const metrics = await providers.agent.collectMetrics(serverRef(withIp));
  await log.success(`Serveur ${withIp.name} prêt`);
  return prisma.server.update({ where: { id: server.id }, data: { status: "ready", metrics } });
}

export type PlacementResult =
  | { kind: "existing"; server: Server }
  | { kind: "new-server"; offerPrice: number | null; offerId: string; reasons: string[] };

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
  try {
    const offers = await providers.cloud.listOffers(settings.defaultZone);
    offerPrice = offers.find((o) => o.id === settings.defaultOffer)?.monthlyPrice ?? null;
  } catch {
    offerPrice = null;
  }
  const reasons = placement.verdicts.flatMap((v) => v.reasons);
  return { kind: "new-server", offerPrice, offerId: settings.defaultOffer, reasons };
}
