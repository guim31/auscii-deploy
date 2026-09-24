import type { Server } from "@prisma/client";
import { prisma } from "../db";
import { raiseAlert } from "./alerts";
import { getProviders } from "../providers";
import { getSettings } from "../settings";
import { bootstrapServer, nextServerName, resumeOrder, serverRef } from "./steps/server";
import { consoleLogger, redactSecrets } from "./log";
import { enqueue, QUEUES } from "./boss";
import type { ServerMetrics } from "../providers/types";
import type { MailSendPayload } from "./mail";

async function collectOne(server: Server): Promise<boolean> {
  const providers = await getProviders({ demo: server.isDemo });
  try {
    const metrics: ServerMetrics = await providers.agent.collectMetrics(serverRef(server));
    const sitesCount = await prisma.site.count({
      where: { serverId: server.id, status: { in: ["ready", "preview", "live"] } },
    });
    await prisma.server.update({
      where: { id: server.id },
      data: { metrics: { ...metrics, sitesCount }, unreachableSince: null },
    });
    return true;
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    console.error(`[health] ${server.name}:`, message);
    await prisma.server.update({
      where: { id: server.id },
      data: { unreachableSince: server.unreachableSince ?? new Date(), lastError: message },
    });
    // No new site goes to an unreachable server; the agency hears about it once a day.
    await raiseAlert({
      kind: "server_unreachable",
      key: server.id,
      subject: `Serveur ${server.name} injoignable`,
      body: [
        `Le relevé horaire de ${server.name} (${server.ip ?? "IP inconnue"}) a échoué.`,
        `Erreur : ${message}`,
        "",
        "Les sites qu'il héberge sont peut-être hors ligne. Aucun nouveau site n'y sera placé tant qu'il ne répond pas.",
      ].join("\n"),
      isDemo: server.isDemo,
    }).catch((e) => console.error("[alerts]", e instanceof Error ? e.message : e));
    return false;
  }
}

/**
 * Collects CPU, RAM, disk and site count of the ready servers, each with the
 * providers of its own mode. `demo` limits the run to one mode (UI refresh);
 * the hourly job covers both.
 */
export async function collectAllMetrics(demo?: boolean): Promise<number> {
  const servers = await prisma.server.findMany({
    where: { status: "ready", ...(demo === undefined ? {} : { isDemo: demo }) },
  });
  let n = 0;
  for (const server of servers) if (await collectOne(server)) n++;
  return n;
}

/** Hosts checked for a site: the domain, www, and the preproduction when deployed. */
function hostsOf(site: {
  domain: string | null;
  liveReleaseId: string | null;
  previewHost: string | null;
  stagingReleaseId: string | null;
}): string[] {
  const hosts: string[] = [];
  if (site.domain && site.liveReleaseId) hosts.push(site.domain, `www.${site.domain}`);
  if (site.previewHost && site.stagingReleaseId) hosts.push(site.previewHost);
  return hosts;
}

/** Checks the certificates of every published site and preproduction. Runs daily. */
export async function checkAllCertificates(): Promise<number> {
  const sites = await prisma.site.findMany({
    where: {
      OR: [{ liveReleaseId: { not: null } }, { stagingReleaseId: { not: null } }],
      status: { not: "draft" },
    },
  });
  let n = 0;
  for (const site of sites) {
    try {
      const providers = await getProviders({ demo: site.isDemo });
      for (const host of hostsOf(site)) {
        const result = await providers.agent.checkTls(host);
        await prisma.sslCheck.create({
          data: {
            siteId: site.id,
            host,
            ok: result.ok,
            issuer: result.issuer,
            expiresAt: result.expiresAt,
            error: result.error,
          },
        });
        n++;
        if (!result.ok)
          await raiseAlert({
            kind: "tls_failure",
            key: host,
            subject: `HTTPS en échec sur ${host}`,
            body: [
              `Le contrôle quotidien du certificat de ${host} (${site.clientName}) a échoué.`,
              `Erreur : ${result.error ?? "certificat invalide"}`,
              "",
              "Vérifiez que le domaine pointe toujours vers le serveur et que Caddy tourne (Paramètres > Serveurs).",
            ].join("\n"),
            isDemo: site.isDemo,
          });
      }
    } catch (err) {
      console.error(`[ssl.check] ${site.slug}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

export type ServerOrderPayload = { serverId: string; confirmedById?: string };

/**
 * Creates the row of a server ordered from Paramètres > Serveurs, before the
 * job runs: a double click is refused, and the job only ever resumes that row.
 */
export async function requestStandaloneOrder(input: {
  offerId: string;
  maxMonthlyPrice: number;
  userId: string;
}): Promise<Server> {
  const recent = await prisma.server.findFirst({
    where: { status: "ordering", isDemo: false, createdAt: { gt: new Date(Date.now() - 120_000) } },
  });
  const providers = await getProviders();
  if (recent && !providers.demo)
    throw new Error("Une commande de serveur est déjà en cours. Patientez quelques minutes.");
  const settings = await getSettings();
  const offers = await providers.cloud.listOffers(settings.defaultZone);
  const offer = offers.find((o) => o.id === input.offerId);
  if (!offer) throw new Error(`L'offre ${input.offerId} n'est pas disponible.`);
  if (offer.monthlyPrice > input.maxMonthlyPrice + 0.01)
    throw new Error(
      `Le prix de l'offre ${offer.id} est de ${offer.monthlyPrice.toFixed(2)} €/mois : rechargez la page et confirmez à nouveau.`,
    );
  // The row exists before the job: the job only ever resumes it, never orders twice.
  const row = await prisma.server.create({
    data: {
      name: await nextServerName(providers.demo),
      provider: providers.demo ? "mock" : "scaleway",
      status: "ordering",
      offer: offer.id,
      zone: settings.defaultZone,
      vcpus: offer.vcpus,
      monthlyPrice: offer.monthlyPrice,
      isDemo: providers.demo,
    },
  });
  await enqueue(QUEUES.serverOrder, {
    serverId: row.id,
    confirmedById: input.userId,
  } satisfies ServerOrderPayload);
  return row;
}

/** Worker: places (or resumes) a standalone order, then installs the server. Never retried. */
export async function runStandaloneOrder({
  serverId,
  confirmedById,
}: ServerOrderPayload): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server || server.status !== "ordering") return;
  const providers = await getProviders({ demo: server.isDemo });
  const settings = await getSettings();
  const log = consoleLogger("[server.order]");
  try {
    const ordered = await resumeOrder(server, providers, settings, log);
    await prisma.auditLog.create({
      data: {
        userId: confirmedById ?? null,
        action: "server.ordered",
        target: ordered.name,
        amount: ordered.monthlyPrice,
        currency: "EUR",
        details: { providerId: ordered.providerId, offer: ordered.offer, source: "settings" },
      },
    });
    await bootstrapServer(ordered, providers, log);
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    await prisma.server.updateMany({
      where: { id: serverId, status: { in: ["ordering", "bootstrapping"] } },
      data: { status: "error", lastError: message },
    });
    console.error("[server.order]", server.name, message);
  }
}

/** Re-queues alerts whose email was never queued or sent (enqueue failure, crash). */
export async function resendPendingAlerts(): Promise<number> {
  const pending = await prisma.alert.findMany({
    where: {
      sentAt: null,
      error: null,
      createdAt: {
        lt: new Date(Date.now() - 15 * 60_000),
        gt: new Date(Date.now() - 2 * 86_400_000),
      },
    },
    select: { id: true },
  });
  for (const a of pending)
    await enqueue(QUEUES.mailSend, { kind: "alert", alertId: a.id } satisfies MailSendPayload);
  return pending.length;
}
