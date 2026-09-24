import { prisma } from "../db";
import { getProviders } from "../providers";
import { GandiProvider } from "../providers/domain/gandi";
import { daysUntil, DOMAIN_EXPIRY_ALERT_DAYS, raiseAlert } from "./alerts";

/**
 * Daily: refreshes expiry date and autorenew state of every domain the agency
 * holds for a site, bought by the tool or already in the account, each with
 * the providers of its own mode.
 */
export async function refreshAllDomains(): Promise<number> {
  const domains = await prisma.domain.findMany({
    where: {
      OR: [{ orderStatus: "registered" }, { owned: true }],
      site: { status: { not: "draft" } },
    },
    select: {
      id: true,
      fqdn: true,
      expiresAt: true,
      autorenew: true,
      site: { select: { isDemo: true } },
    },
  });
  let n = 0;
  for (const d of domains) {
    try {
      const providers = await getProviders({ demo: d.site.isDemo });
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
          await alertIfExpiring(d.fqdn, info.expiresAt, info.autorenew, d.site.isDemo);
        }
      } else {
        // Demo: nothing to fetch, just record the check.
        await prisma.domain.update({
          where: { id: d.id },
          data: { autorenew: true, lastCheckedAt: new Date() },
        });
        n++;
        await alertIfExpiring(d.fqdn, d.expiresAt, true, d.site.isDemo);
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
      `Le domaine ${fqdn} ${when} (${expiresAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}).`,
      autorenew
        ? "Le renouvellement automatique est actif chez Gandi : vérifiez que le moyen de paiement est valide."
        : "Le renouvellement automatique est désactivé : renouvelez le domaine chez Gandi avant l'échéance.",
    ].join("\n"),
    isDemo,
  });
  return true;
}
