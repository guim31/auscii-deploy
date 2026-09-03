import { prisma } from "../db";
import { getProviders } from "../providers";
import { GandiProvider } from "../providers/domain/gandi";
import { daysUntil, DOMAIN_EXPIRY_ALERT_DAYS, raiseAlert } from "./alerts";

/** Daily: refreshes expiry date and autorenew state of every registered domain. */
export async function refreshAllDomains(): Promise<number> {
  const providers = await getProviders();
  const domains = await prisma.domain.findMany({
    where: { orderStatus: "registered", site: { isDemo: providers.demo } },
    select: { id: true, fqdn: true, expiresAt: true, autorenew: true },
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
          await alertIfExpiring(d.fqdn, info.expiresAt, info.autorenew, providers.demo);
        }
      } else {
        // Demo: nothing to fetch, just record the check.
        await prisma.domain.update({
          where: { id: d.id },
          data: { autorenew: true, lastCheckedAt: new Date() },
        });
        n++;
        await alertIfExpiring(d.fqdn, d.expiresAt, true, providers.demo);
      }
    } catch (err) {
      console.error(`[domain.refresh] ${d.fqdn}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

/** Emails the agency once a day while a domain expires within 30 days. */
export async function alertIfExpiring(
  fqdn: string,
  expiresAt: Date | null | undefined,
  autorenew: boolean,
  isDemo: boolean,
): Promise<boolean> {
  if (!expiresAt) return false;
  const days = daysUntil(expiresAt);
  if (days > DOMAIN_EXPIRY_ALERT_DAYS) return false;
  const when =
    days < 0 ? "a expiré" : days === 0 ? "expire aujourd'hui" : `expire dans ${days} jour(s)`;
  await raiseAlert({
    kind: "domain_expiry",
    key: fqdn,
    subject: `Le domaine ${fqdn} ${when}`,
    body: [
      `Le domaine ${fqdn} ${when} (${expiresAt.toISOString().slice(0, 10)}).`,
      autorenew
        ? "Le renouvellement automatique est actif chez Gandi : vérifiez que le moyen de paiement est valide."
        : "Le renouvellement automatique est désactivé : renouvelez le domaine chez Gandi avant l'échéance.",
    ].join("\n"),
    isDemo,
  });
  return true;
}
