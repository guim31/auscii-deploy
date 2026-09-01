import { prisma } from "../db";
import { getProviders } from "../providers";
import { serverRef } from "./steps/server";
import type { ServerMetrics } from "../providers/types";

/** Collects CPU, RAM, disk and site count for every ready server. Runs hourly and on demand. */
export async function collectAllMetrics(): Promise<number> {
  const providers = await getProviders();
  const servers = await prisma.server.findMany({
    where: { status: "ready", isDemo: providers.demo },
  });
  let n = 0;
  for (const server of servers) {
    try {
      const metrics: ServerMetrics = await providers.agent.collectMetrics(serverRef(server));
      const sitesCount = await prisma.site.count({
        where: { serverId: server.id, status: { in: ["ready", "preview", "live"] } },
      });
      await prisma.server.update({
        where: { id: server.id },
        data: { metrics: { ...metrics, sitesCount } },
      });
      n++;
    } catch (err) {
      console.error(`[health] ${server.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

/** Checks the certificate of every live site. Runs daily. */
export async function checkAllCertificates(): Promise<number> {
  const providers = await getProviders();
  const sites = await prisma.site.findMany({
    where: { status: "live", isDemo: providers.demo, domain: { not: null } },
  });
  let n = 0;
  for (const site of sites) {
    const result = await providers.agent.checkTls(site.domain!);
    await prisma.sslCheck.create({
      data: {
        siteId: site.id,
        host: site.domain!,
        ok: result.ok,
        issuer: result.issuer,
        expiresAt: result.expiresAt,
        error: result.error,
      },
    });
    n++;
  }
  return n;
}

/** Orders a server outside of the wizard (Paramètres > Serveurs). */
export async function orderStandaloneServer(offerId?: string) {
  const { getSettings } = await import("../settings");
  const { orderServer, bootstrapServer } = await import("./steps/server");
  const providers = await getProviders();
  const settings = await getSettings();
  const log = {
    info: async (m: string) => console.log("[server.order]", m),
    success: async (m: string) => console.log("[server.order]", m),
    warn: async (m: string) => console.warn("[server.order]", m),
    error: async (m: string) => console.error("[server.order]", m),
  };
  const server = await orderServer(providers, settings, log, offerId);
  try {
    return await bootstrapServer(server, providers, log);
  } catch (err) {
    await prisma.server.update({ where: { id: server.id }, data: { status: "error" } });
    throw err;
  }
}
