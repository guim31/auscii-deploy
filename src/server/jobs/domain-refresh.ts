import { prisma } from "../db";
import { getProviders } from "../providers";
import { GandiProvider } from "../providers/domain/gandi";

/** Daily: refreshes expiry date and autorenew state of every registered domain. */
export async function refreshAllDomains(): Promise<number> {
  const providers = await getProviders();
  const domains = await prisma.domain.findMany({
    where: { orderStatus: "registered", site: { isDemo: providers.demo } },
    select: { id: true, fqdn: true },
  });
  let n = 0;
  for (const d of domains) {
    try {
      if (providers.domain instanceof GandiProvider) {
        const info = await providers.domain.domainInfo(d.fqdn);
        if (info) {
          await prisma.domain.update({
            where: { id: d.id },
            data: {
              expiresAt: info.expiresAt,
              autorenew: info.autorenew,
              lastCheckedAt: new Date(),
            },
          });
          n++;
        }
      } else {
        // Demo: nothing to fetch, just record the check.
        await prisma.domain.update({
          where: { id: d.id },
          data: { autorenew: true, lastCheckedAt: new Date() },
        });
        n++;
      }
    } catch (err) {
      console.error(`[domain.refresh] ${d.fqdn}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}
