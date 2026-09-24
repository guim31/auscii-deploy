import { prisma } from "../db";
import { getProviders } from "../providers";
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
      const info = await providers.domain.getDomain(d.fqdn);
      if (!info) {
        console.warn(`[domain.refresh] ${d.fqdn} n'est plus dans le compte`);
        continue;
      }
      const expiresAt = info.expiresAt ?? d.expiresAt;
      const autorenew = info.autorenew ?? d.autorenew;
      await prisma.domain.update({
        where: { id: d.id },
        data: { expiresAt, autorenew, lastCheckedAt: new Date() },
      });
      n++;
      await alertIfExpiring(d.fqdn, expiresAt, autorenew, d.site.isDemo);
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
