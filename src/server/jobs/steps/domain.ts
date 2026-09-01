import type { Domain, Server } from "@prisma/client";
import { prisma } from "../../db";
import type { Providers } from "../../providers";
import type { Settings } from "../../settings";
import { previewHostFor } from "../../settings";
import type { Logger } from "../log";

export async function registerDomain(
  domain: Domain,
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<Domain> {
  if (domain.owned || domain.orderStatus === "registered") return domain;
  if (!domain.orderId) {
    await log.info(
      `Achat de ${domain.fqdn} chez Gandi (${domain.price?.toFixed(2) ?? "?"} ${domain.currency ?? "EUR"})`,
    );
    const order = await providers.domain.register(domain.fqdn, {
      organizationId: settings.gandiContact.organizationId || undefined,
      email: settings.gandiContact.email || "contact@auscii.com",
    });
    if (order.status === "failed") throw new Error(order.message ?? "Achat du domaine refusé");
    domain = await prisma.domain.update({
      where: { id: domain.id },
      data: { orderId: order.orderId, orderStatus: "pending" },
    });
  }
  for (let i = 0; i < 40; i++) {
    const order = await providers.domain.getOrder(domain.orderId!);
    if (order.status === "registered") {
      await log.success(
        `${domain.fqdn} enregistré${order.expiresAt ? ` jusqu'au ${order.expiresAt.toLocaleDateString("fr-FR")}` : ""}`,
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
    await log.info("Enregistrement en cours chez le registrar…");
  }
  throw new Error("L'enregistrement du domaine prend trop de temps, relancez plus tard");
}

export async function configureDns(
  domain: Domain,
  slug: string,
  server: Server,
  providers: Providers,
  settings: Settings,
  log: Logger,
): Promise<Domain> {
  if (!server.ip) throw new Error(`Le serveur ${server.name} n'a pas d'adresse IP`);
  await log.info(`Enregistrements A pour ${domain.fqdn} et www.${domain.fqdn} → ${server.ip}`);
  await providers.domain.setRecords(domain.fqdn, [
    { name: "@", type: "A", values: [server.ip], ttl: 300 },
    { name: "www", type: "A", values: [server.ip], ttl: 300 },
  ]);
  const previewHost = previewHostFor(slug, settings);
  await log.info(`Enregistrement A pour ${previewHost} → ${server.ip}`);
  await providers.domain.setRecords(settings.techDomain, [
    {
      name: previewHost.replace(`.${settings.techDomain}`, ""),
      type: "A",
      values: [server.ip],
      ttl: 300,
    },
  ]);
  return prisma.domain.update({ where: { id: domain.id }, data: { dnsConfigured: true } });
}
