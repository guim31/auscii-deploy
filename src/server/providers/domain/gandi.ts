import type {
  DomainAvailability,
  DomainContact,
  DomainOrder,
  DomainProvider,
  DnsRecord,
} from "../types";
import { ProviderNotConfiguredError } from "../types";
import { GandiClient, GandiError, type FetchLike } from "./gandi-client";

export type GandiCredentials = { apiKey: string; organizationId?: string };

type CheckResponse = {
  currency?: string;
  products?: {
    name: string;
    status: string;
    process?: string;
    tags?: string[];
    prices?: {
      duration_unit?: string;
      min_duration?: number;
      max_duration?: number;
      price_after_taxes?: number;
      price_before_taxes?: number;
    }[];
  }[];
};

type DomainInfo = {
  fqdn: string;
  status?: string[];
  dates?: { registry_ends_at?: string; hosted_ends_at?: string };
  autorenew?: { enabled?: boolean } | boolean;
};

type Organization = { id: string; name?: string; type?: string };

const SUGGEST_TLDS = ["fr", "com", "eu", "net"];
const CHECK_CACHE_MS = 60_000;

/** Maps our contact to Gandi's owner contact. Type 1 = company, 0 = person. */
export function toGandiOwner(contact: DomainContact) {
  const company = Boolean(contact.orgName);
  return {
    type: company ? 1 : 0,
    orgname: company ? contact.orgName : undefined,
    given: contact.givenName ?? "",
    family: contact.familyName ?? "",
    email: contact.email,
    phone: contact.phone ?? "",
    streetaddr: contact.street ?? "",
    zip: contact.zip ?? "",
    city: contact.city ?? "",
    country: (contact.country ?? "FR").toUpperCase(),
  };
}

export function missingContactFields(contact: DomainContact): string[] {
  const required: [keyof DomainContact, string][] = [
    ["email", "email"],
    ["givenName", "prénom"],
    ["familyName", "nom"],
    ["phone", "téléphone"],
    ["street", "adresse"],
    ["zip", "code postal"],
    ["city", "ville"],
    ["country", "pays"],
  ];
  return required.filter(([k]) => !contact[k]).map(([, label]) => label);
}

export function availabilityFromCheck(fqdn: string, res: CheckResponse): DomainAvailability {
  const product = res.products?.find((p) => p.name === fqdn) ?? res.products?.[0];
  if (!product)
    return { fqdn, available: false, reason: "Extension non prise en charge par Gandi" };
  const status = product.status ?? "";
  if (status === "error_invalid")
    return { fqdn, available: false, reason: "Nom de domaine invalide" };
  if (status === "error_refused" || status === "reserved" || status === "unavailable")
    return { fqdn, available: false, reason: "Déjà enregistré ou réservé" };
  if (!status.startsWith("available"))
    return { fqdn, available: false, reason: `Indisponible (${status})` };
  if (status === "available_reserved")
    return { fqdn, available: false, reason: "Réservé par le registre" };
  const yearly =
    product.prices?.find((p) => (p.duration_unit ?? "y") === "y" && (p.min_duration ?? 1) <= 1) ??
    product.prices?.[0];
  const premium = status === "available_premium" || (product.tags ?? []).includes("is_premium");
  return {
    fqdn,
    available: true,
    price: yearly?.price_after_taxes ?? yearly?.price_before_taxes,
    currency: res.currency ?? "EUR",
    premium,
    reason: premium ? "Domaine premium, prix majoré" : undefined,
  };
}

export function orderFromDomainInfo(fqdn: string, info: DomainInfo | null): DomainOrder {
  if (!info)
    return { orderId: fqdn, status: "pending", message: "Enregistrement en cours chez Gandi" };
  const ends = info.dates?.registry_ends_at;
  return { orderId: fqdn, status: "registered", expiresAt: ends ? new Date(ends) : undefined };
}

/** Real Gandi v5 implementation: domain availability, registration, LiveDNS records. */
export class GandiProvider implements DomainProvider {
  readonly name = "gandi";
  private readonly client: GandiClient | null;
  private readonly checkCache = new Map<string, { at: number; value: DomainAvailability }>();

  constructor(
    private readonly creds: GandiCredentials | null,
    fetchImpl?: FetchLike,
  ) {
    this.client = creds?.apiKey
      ? new GandiClient(creds.apiKey, creds.organizationId || undefined, fetchImpl)
      : null;
  }

  private api(): GandiClient {
    if (!this.client)
      throw new ProviderNotConfiguredError(
        "Gandi",
        "Clé API Gandi manquante (Paramètres > Intégrations).",
      );
    return this.client;
  }

  async check(fqdn: string): Promise<DomainAvailability> {
    const cached = this.checkCache.get(fqdn);
    if (cached && Date.now() - cached.at < CHECK_CACHE_MS) return cached.value;
    const { data } = await this.api().request<CheckResponse>(
      "GET",
      `/domain/check?name=${encodeURIComponent(fqdn)}`,
      { sharing: true },
    );
    const value = availabilityFromCheck(fqdn, data);
    this.checkCache.set(fqdn, { at: Date.now(), value });
    return value;
  }

  async suggest(base: string): Promise<DomainAvailability[]> {
    const label = base.toLowerCase().split(".")[0];
    return Promise.all(
      SUGGEST_TLDS.map((tld) =>
        this.check(`${label}.${tld}`).catch((err): DomainAvailability => ({
          fqdn: `${label}.${tld}`,
          available: false,
          reason: err instanceof Error ? err.message : "erreur",
        })),
      ),
    );
  }

  async register(fqdn: string, contact: DomainContact): Promise<DomainOrder> {
    const missing = missingContactFields(contact);
    if (missing.length)
      return {
        orderId: fqdn,
        status: "failed",
        message: `Contact propriétaire incomplet (Paramètres > Agence) : ${missing.join(", ")}`,
      };
    const body = { fqdn, owner: toGandiOwner(contact), duration: 1 };
    try {
      await this.api().request("POST", "/domain/domains", {
        body,
        headers: { "Dry-Run": "1" },
        sharing: true,
        expect: [200, 202],
      });
    } catch (err) {
      if (err instanceof GandiError)
        return {
          orderId: fqdn,
          status: "failed",
          message: `Validation refusée avant achat : ${err.message}`,
        };
      throw err;
    }
    const { data } = await this.api().request<{ message?: string }>("POST", "/domain/domains", {
      body,
      sharing: true,
      expect: [200, 202],
    });
    return {
      orderId: fqdn,
      status: "pending",
      message: data?.message ?? "Commande envoyée à Gandi",
    };
  }

  async getOrder(orderId: string): Promise<DomainOrder> {
    const fqdn = orderId;
    let info: DomainInfo | null = null;
    try {
      info = (
        await this.api().request<DomainInfo>("GET", `/domain/domains/${encodeURIComponent(fqdn)}`, {
          sharing: true,
        })
      ).data;
    } catch (err) {
      if (err instanceof GandiError && err.status === 404) return orderFromDomainInfo(fqdn, null);
      throw err;
    }
    const order = orderFromDomainInfo(fqdn, info);
    const autorenewOn =
      typeof info.autorenew === "object"
        ? Boolean(info.autorenew?.enabled)
        : Boolean(info.autorenew);
    if (order.status === "registered" && !autorenewOn) {
      try {
        await this.api().request("PATCH", `/domain/domains/${encodeURIComponent(fqdn)}/autorenew`, {
          body: { enabled: true, duration: 1 },
          sharing: true,
        });
      } catch (err) {
        order.message = `Renouvellement automatique non activé : ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return order;
  }

  /** Expiry and autorenew state of an owned domain, for the daily refresh. */
  async domainInfo(fqdn: string): Promise<{ expiresAt?: Date; autorenew: boolean } | null> {
    try {
      const { data } = await this.api().request<DomainInfo>(
        "GET",
        `/domain/domains/${encodeURIComponent(fqdn)}`,
        { sharing: true },
      );
      const ends = data.dates?.registry_ends_at;
      return {
        expiresAt: ends ? new Date(ends) : undefined,
        autorenew:
          typeof data.autorenew === "object"
            ? Boolean(data.autorenew?.enabled)
            : Boolean(data.autorenew),
      };
    } catch (err) {
      if (err instanceof GandiError && err.status === 404) return null;
      throw err;
    }
  }

  async listOwned(): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      const { data, headers } = await this.api().request<DomainInfo[]>(
        "GET",
        `/domain/domains?per_page=100&page=${page}`,
        { sharing: true },
      );
      out.push(...(data ?? []).map((d) => d.fqdn));
      const total = Number(headers.get("total-count") ?? 0);
      if (!data?.length || out.length >= total) break;
    }
    return out;
  }

  async setRecords(zone: string, records: DnsRecord[]): Promise<void> {
    for (const r of records) {
      await this.api().request(
        "PUT",
        `/livedns/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(r.name)}/${r.type}`,
        {
          body: { rrset_ttl: r.ttl ?? 300, rrset_values: r.values },
          sharing: true,
          expect: [200, 201],
        },
      );
    }
  }

  /** Used by the settings "Tester" button. */
  async whoAmI(): Promise<{ user: string; organizations: Organization[] }> {
    const me = (
      await this.api().request<{ username?: string; email?: string }>(
        "GET",
        "/organization/user-info",
      )
    ).data;
    const orgs =
      (await this.api().request<Organization[]>("GET", "/organization/organizations")).data ?? [];
    return { user: me.username ?? me.email ?? "?", organizations: orgs };
  }
}
