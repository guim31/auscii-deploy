import type { Domain, Server } from "@prisma/client";
import { prisma } from "../../db";
import type { DnsRecordType, Providers } from "../../providers";
import type { Settings } from "../../settings";
import { previewHostFor, previewZone } from "../../settings";
import type { Logger } from "../log";

const ORDER_POLL_ATTEMPTS = 60;
const ORDER_POLL_DELAY_MS = 15_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function contactFrom(settings: Settings) {
  const c = settings.gandiContact;
  return {
    organizationId: c.organizationId || undefined,
    email: c.email,
    orgName: c.orgName || undefined,
    givenName: c.givenName || undefined,
    familyName: c.familyName || undefined,
    phone: c.phone || undefined,
    street: c.street || undefined,
    zip: c.zip || undefined,
    city: c.city || undefined,
    country: c.country || undefined,
    siren: c.siren || undefined,
  };
}

/**
 * Buys the domain, then waits for the registry. Idempotent: the status is set
 * to "ordering" before the purchase request, so an interrupted attempt looks
 * the domain up in the account instead of buying it again. The price confirmed
 * by the admin is passed along: the provider refuses to buy above it.
 */
export async function registerDomain(
  domain: Domain,
  providers: Providers,
  settings: Settings,
  log: Logger,
  opts: { confirmedById?: string | null } = {},
): Promise<Domain> {
  if (domain.owned || domain.orderStatus === "registered") return domain;
  if (!domain.orderId) {
    if (domain.orderStatus === "ordering" || domain.orderStatus === "pending") {
      const existing = await providers.domain.getDomain(domain.fqdn);
      if (existing) {
        await log.info(`${domain.fqdn} est déjà dans le compte : la commande précédente a abouti`);
        domain = await prisma.domain.update({
          where: { id: domain.id },
          data: { orderId: domain.fqdn, orderStatus: "pending" },
        });
      }
    }
  }
  if (!domain.orderId) {
    await log.info(
      `Achat de ${domain.fqdn} chez Gandi (${domain.price?.toFixed(2) ?? "?"} ${domain.currency ?? "EUR"})`,
    );
    domain = await prisma.domain.update({
      where: { id: domain.id },
      data: { orderStatus: "ordering" },
    });
    const order = await providers.domain.register(domain.fqdn, contactFrom(settings), {
      expectedPrice: domain.price ?? undefined,
      currency: domain.currency ?? undefined,
    });
    if (order.status === "failed") {
      await prisma.domain.update({ where: { id: domain.id }, data: { orderStatus: "failed" } });
      throw new Error(order.message ?? "Achat du domaine refusé");
    }
    domain = await prisma.domain.update({
      where: { id: domain.id },
      data: { orderId: order.orderId, orderStatus: "pending" },
    });
    await prisma.auditLog.create({
      data: {
        userId: opts.confirmedById ?? null,
        action: "domain.purchased",
        target: domain.fqdn,
        amount: domain.price,
        currency: domain.currency ?? "EUR",
        details: { orderId: order.orderId, siteId: domain.siteId },
      },
    });
  }
  // Gandi usually registers within a couple of minutes; poll for up to 15 minutes.
  for (let i = 0; i < ORDER_POLL_ATTEMPTS; i++) {
    if (i > 0) await sleep(providers.demo ? 200 : ORDER_POLL_DELAY_MS);
    const order = await providers.domain.getOrder(domain.orderId!);
    if (order.status === "registered") {
      await log.success(
        `${domain.fqdn} enregistré${order.expiresAt ? ` jusqu'au ${order.expiresAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}` : ""}`,
      );
      return prisma.domain.update({
        where: { id: domain.id },
        data: { orderStatus: "registered", expiresAt: order.expiresAt },
      });
    }
    if (order.status === "failed") {
      await prisma.domain.update({ where: { id: domain.id }, data: { orderStatus: "failed" } });
      throw new Error(order.message ?? "L'enregistrement du domaine a échoué");
    }
    if (i % 4 === 0) await log.info(order.message ?? "Enregistrement en cours chez le registrar…");
  }
  throw new Error(
    "Gandi n'a pas encore terminé l'enregistrement. Relancez cette étape dans quelques minutes : la commande n'est pas perdue.",
  );
}

/**
 * Checks a domain declared as "already in the Gandi account": it must be there
 * and served by LiveDNS for the tool to write its records.
 */
export async function verifyOwnedDomain(
  domain: Domain,
  providers: Providers,
  log: Logger,
): Promise<{ usesProviderDns: boolean }> {
  const info = await providers.domain.getDomain(domain.fqdn);
  if (!info)
    throw new Error(
      `${domain.fqdn} n'est pas dans le compte Gandi de l'agence. Revenez à l'étape 1 pour l'acheter, ou transférez-le d'abord sur le compte.`,
    );
  await prisma.domain.update({
    where: { id: domain.id },
    data: { expiresAt: info.expiresAt ?? undefined, lastCheckedAt: new Date() },
  });
  if (!info.usesProviderDns)
    await log.warn(
      `${domain.fqdn} n'utilise pas les serveurs DNS de Gandi (LiveDNS) : les enregistrements devront être créés chez son hébergeur DNS.`,
    );
  return { usesProviderDns: info.usesProviderDns };
}

/** Types that cannot coexist with the A record we write, or would send visitors elsewhere. */
const CONFLICTING: Record<"@" | "www", DnsRecordType[]> = {
  "@": ["AAAA", "ALIAS", "CNAME"],
  www: ["CNAME", "AAAA", "ALIAS"],
};

export async function configureDns(
  domain: Domain,
  slug: string,
  server: Server,
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<Domain> {
  if (!server.ip) throw new Error(`Le serveur ${server.name} n'a pas d'adresse IP`);
  // A new Gandi zone points www to a web redirection (CNAME) and may carry AAAA
  // records: they would win over our A records (IPv6 visitors, certificates).
  for (const name of ["@", "www"] as const) {
    const removed = await providers.domain.deleteRecords(domain.fqdn, name, CONFLICTING[name]);
    if (removed.length > 0)
      await log.info(
        `Enregistrements ${removed.join(", ")} retirés sur ${name === "@" ? domain.fqdn : `www.${domain.fqdn}`}`,
      );
  }
  await log.info(`Enregistrements A pour ${domain.fqdn} et www.${domain.fqdn} → ${server.ip}`);
  await providers.domain.setRecords(domain.fqdn, [
    { name: "@", type: "A", values: [server.ip], ttl: 300 },
    { name: "www", type: "A", values: [server.ip], ttl: 300 },
  ]);
  const zone = previewZone(settings);
  const previewHost = previewHostFor(slug, settings);
  await log.info(`Enregistrement A pour ${previewHost} → ${server.ip}`);
  await providers.domain.setRecords(zone, [
    {
      name: previewHost.slice(0, -(zone.length + 1)),
      type: "A",
      values: [server.ip],
      ttl: 300,
    },
  ]);
  return prisma.domain.update({ where: { id: domain.id }, data: { dnsConfigured: true } });
}
