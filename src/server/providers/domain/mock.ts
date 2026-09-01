import type {
  DomainAvailability,
  DomainContact,
  DomainOrder,
  DomainProvider,
  DnsRecord,
} from "../types";
import { hashInt, sleep } from "../mock-utils";

const PRICES: Record<string, number> = {
  fr: 12.5,
  com: 14.9,
  eu: 9.9,
  net: 15.9,
  org: 13.9,
  site: 8.9,
  io: 39,
};
const TAKEN = ["google", "auscii", "leboncoin", "orange", "sncf", "amazon", "apple", "test"];

const orders = new Map<string, { fqdn: string; createdAt: number }>();
const owned = new Set<string>(["auscii.site"]);
const zones = new Map<string, DnsRecord[]>();

function splitFqdn(fqdn: string): { label: string; tld: string } {
  const parts = fqdn.toLowerCase().split(".");
  const tld = parts.pop() ?? "";
  return { label: parts.join("."), tld };
}

export class MockDomainProvider implements DomainProvider {
  readonly name = "mock-gandi";

  async check(fqdn: string): Promise<DomainAvailability> {
    await sleep(600 + hashInt(fqdn, 400));
    const { label, tld } = splitFqdn(fqdn);
    if (!label || !tld) return { fqdn, available: false, reason: "Nom de domaine invalide" };
    if (owned.has(fqdn.toLowerCase()))
      return { fqdn, available: false, reason: "Déjà dans votre compte Gandi" };
    const price = PRICES[tld];
    if (!price) return { fqdn, available: false, reason: `Extension .${tld} non prise en charge` };
    const taken = TAKEN.some((t) => label === t) || label.length < 3 || hashInt(fqdn, 10) === 0;
    if (taken) return { fqdn, available: false, reason: "Déjà enregistré" };
    return { fqdn, available: true, price, currency: "EUR" };
  }

  async suggest(base: string): Promise<DomainAvailability[]> {
    const { label } = splitFqdn(base.includes(".") ? base : `${base}.fr`);
    const tlds = ["fr", "com", "eu", "net"];
    return Promise.all(tlds.map((tld) => this.check(`${label}.${tld}`)));
  }

  async register(fqdn: string, contact: DomainContact): Promise<DomainOrder> {
    await sleep(1200);
    if (!contact.email) return { orderId: "", status: "failed", message: "Contact Gandi manquant" };
    const orderId = `mock-order-${hashInt(fqdn, 100000)}`;
    orders.set(orderId, { fqdn, createdAt: Date.now() });
    return { orderId, status: "pending", message: "Commande enregistrée chez Gandi" };
  }

  async getOrder(orderId: string): Promise<DomainOrder> {
    await sleep(800);
    const order = orders.get(orderId);
    if (!order) return { orderId, status: "failed", message: "Commande introuvable" };
    // Registered a couple of seconds after creation, instant in tests.
    const elapsed = Date.now() - order.createdAt;
    if (elapsed < 2000 && process.env.NODE_ENV !== "test") return { orderId, status: "pending" };
    owned.add(order.fqdn.toLowerCase());
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    return { orderId, status: "registered", expiresAt };
  }

  async listOwned(): Promise<string[]> {
    await sleep(300);
    return [...owned];
  }

  async setRecords(zone: string, records: DnsRecord[]): Promise<void> {
    await sleep(900);
    const current = zones.get(zone) ?? [];
    const next = current.filter(
      (r) => !records.some((n) => n.name === r.name && n.type === r.type),
    );
    zones.set(zone, [...next, ...records]);
  }

  /** Test helper. */
  static _records(zone: string): DnsRecord[] {
    return zones.get(zone) ?? [];
  }
}
