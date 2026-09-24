import type {
  DomainAvailability,
  DomainContact,
  DomainOrder,
  DomainProvider,
  DnsRecord,
  DnsRecordType,
  OwnedDomain,
} from "../types";
import { ProviderNotConfiguredError } from "../types";
import { cleanSecret } from "../http-utils";
import { GandiClient, GandiError, type FetchLike, type GandiErrorBody } from "./gandi-client";

export type GandiCredentials = { apiKey: string; organizationId?: string };

type CheckPrice = {
  duration_unit?: string;
  min_duration?: number;
  max_duration?: number;
  price_after_taxes?: number;
  price_before_taxes?: number;
  /** Promotion flag; the normal price is then given apart (field names not confirmed, read defensively). */
  discount?: boolean;
  normal_price_after_taxes?: number;
  normal_price_before_taxes?: number;
};

type CheckResponse = {
  currency?: string;
  products?: {
    name: string;
    status: string;
    process?: string;
    tags?: string[];
    prices?: CheckPrice[];
  }[];
};

/** GET /domain/domains/{fqdn} (go-gandi `domain.Details`). */
type DomainDetails = {
  fqdn: string;
  status?: string[];
  dates?: { registry_ends_at?: string; hosted_ends_at?: string };
  autorenew?: { enabled?: boolean } | boolean;
  nameservers?: string[];
  services?: string[];
  /** Only present in the list endpoint (go-gandi `ListResponse`), read when available. */
  nameserver?: { current?: string; hosts?: string[] };
};

type LiveDnsInfo = { current?: string; nameservers?: string[] };

type Organization = { id: string; name?: string; type?: string };

const SUGGEST_TLDS = ["fr", "com", "eu", "net"];
const CHECK_CACHE_MS = 60_000;
/** A domain still absent from the account this long after the order is considered failed. */
const ORDER_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Tolerance when comparing a price with the confirmed one (rounding of taxes). */
const PRICE_EPSILON = 0.01;

/**
 * Calling codes used to split an international number into Gandi's
 * `+CC.NNNN` format. The ITU plan is prefix-free, so the longest match wins.
 */
const CALLING_CODES = [
  "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45",
  "46", "47", "48", "49", "51", "52", "54", "55", "56", "57", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "212", "213", "216", "262", "351", "352", "353", "354",
  "356", "357", "358", "359", "370", "371", "372", "376", "377", "385", "386", "420", "421",
  "423", "508", "590", "594", "596", "687", "689",
]; // prettier-ignore

/**
 * Normalises a phone number to Gandi's format `+33.612345678`. Accepts
 * `06 12 34 56 78` (French national format), `+33 6 12 34 56 78`,
 * `+33 (0)6…`, `0033…` and the already normalised form. Returns null when the
 * number cannot be understood: the settings should then ask for `+33.6…`.
 */
export function normalizeGandiPhone(raw: string, country = "FR"): string | null {
  const input = raw.trim();
  if (/^\+\d{1,3}\.\d{4,14}$/.test(input)) return input;
  let s = input.replace(/\(0\)/g, "").replace(/[\s.\-()/]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!/^\+?\d+$/.test(s)) return null;
  if (!s.startsWith("+")) {
    // National format: only the French one (trunk prefix 0) is supported.
    if (country.toUpperCase() !== "FR" || !/^0\d{9}$/.test(s)) return null;
    return `+33.${s.slice(1)}`;
  }
  const digits = s.slice(1);
  const code = [...CALLING_CODES]
    .sort((a, b) => b.length - a.length)
    .find((c) => digits.startsWith(c));
  if (!code) return null;
  let rest = digits.slice(code.length);
  // "+33 06…" is a common mistake: drop the national trunk prefix.
  if (code === "33" && rest.length === 10 && rest.startsWith("0")) rest = rest.slice(1);
  if (rest.length < 4 || rest.length > 14) return null;
  return `+${code}.${rest}`;
}

/** Maps our contact to Gandi's owner contact. Type 1 = company, 0 = person. */
export function toGandiOwner(contact: DomainContact) {
  const company = Boolean(contact.orgName);
  const country = (contact.country ?? "FR").toUpperCase();
  const phone = contact.phone ? (normalizeGandiPhone(contact.phone, country) ?? contact.phone) : "";
  const siren = contact.siren?.replace(/\s/g, "");
  return {
    type: company ? 1 : 0,
    orgname: company ? contact.orgName : undefined,
    given: contact.givenName ?? "",
    family: contact.familyName ?? "",
    email: contact.email,
    phone,
    streetaddr: contact.street ?? "",
    zip: contact.zip ?? "",
    city: contact.city ?? "",
    country,
    ...(company && siren ? { siren } : {}),
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

function yearlyPrice(prices: CheckPrice[] | undefined): CheckPrice | undefined {
  return (
    prices?.find((p) => (p.duration_unit ?? "y") === "y" && (p.min_duration ?? 1) <= 1) ??
    prices?.[0]
  );
}

export function availabilityFromCheck(fqdn: string, res: CheckResponse): DomainAvailability {
  const product =
    res.products?.find((p) => p.name === fqdn && (p.process ?? "create") === "create") ??
    res.products?.find((p) => p.name === fqdn) ??
    res.products?.[0];
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
  const yearly = yearlyPrice(product.prices);
  const premium = status === "available_premium" || (product.tags ?? []).includes("is_premium");
  const renew = res.products?.find((p) => p.name === fqdn && p.process === "renew");
  const renewYearly = yearlyPrice(renew?.prices);
  const renewPrice =
    renewYearly?.price_after_taxes ??
    (yearly?.discount ? yearly.normal_price_after_taxes : undefined);
  return {
    fqdn,
    available: true,
    price: yearly?.price_after_taxes ?? yearly?.price_before_taxes,
    priceBeforeTaxes: yearly?.price_before_taxes,
    renewPrice,
    currency: res.currency ?? "EUR",
    premium,
    reason: premium ? "Domaine premium, prix majoré" : undefined,
  };
}

const PENDING_STATUSES = new Set(["pendingcreate", "pendingtransfer"]);
const BLOCKED_STATUSES = new Set([
  "clienthold",
  "serverhold",
  "pendingdelete",
  "redemptionperiod",
  "pendingrestore",
  "inactive",
  "expired",
]);

/** Registry (EPP) statuses → our status. A creation in progress wins over anything else. */
export function domainStatusFrom(statuses: string[] | undefined): OwnedDomain["status"] {
  const lower = (statuses ?? []).map((s) => s.toLowerCase());
  if (lower.some((s) => PENDING_STATUSES.has(s))) return "pending";
  if (lower.some((s) => BLOCKED_STATUSES.has(s))) return "other";
  return "active";
}

function autorenewOf(info: Pick<DomainDetails, "autorenew">): boolean {
  return typeof info.autorenew === "object"
    ? Boolean(info.autorenew?.enabled)
    : Boolean(info.autorenew);
}

/** LiveDNS name servers look like ns-123-a.gandi.net. */
function looksLikeLiveDns(nameservers: string[] | undefined): boolean {
  return (
    Boolean(nameservers?.length) &&
    nameservers!.every((ns) => /^ns-\d+-[a-z]\.gandi\.net\.?$/i.test(ns.trim()))
  );
}

/** Order ids carry the order time, so a domain that never appears can end as failed. */
export function orderIdFor(fqdn: string, at = Date.now()): string {
  return `${fqdn}@${at}`;
}

export function parseOrderId(orderId: string): { fqdn: string; orderedAt?: number } {
  const [fqdn, at] = orderId.split("@");
  const n = Number(at);
  return { fqdn, orderedAt: at && Number.isFinite(n) ? n : undefined };
}

export function orderFromOwnedDomain(
  orderId: string,
  domain: OwnedDomain | null,
  now = Date.now(),
): DomainOrder {
  const { orderedAt } = parseOrderId(orderId);
  if (!domain) {
    if (orderedAt && now - orderedAt > ORDER_GIVE_UP_MS)
      return {
        orderId,
        status: "failed",
        message:
          "Le domaine n'est toujours pas dans le compte Gandi 24 h après la commande : elle a probablement été refusée (paiement, registre). Vérifiez les commandes et la facturation dans l'interface Gandi.",
      };
    return { orderId, status: "pending", message: "Enregistrement en cours chez Gandi" };
  }
  if (domain.status === "active")
    return { orderId, status: "registered", expiresAt: domain.expiresAt };
  if (domain.status === "pending")
    return {
      orderId,
      status: "pending",
      message: "Création en cours auprès du registre (pendingCreate)",
    };
  return {
    orderId,
    status: "pending",
    message: `Domaine présent chez Gandi mais bloqué (${(domain.registryStatus ?? []).join(", ") || "statut inconnu"}) : vérifiez-le dans l'interface Gandi.`,
  };
}

/** @deprecated kept for callers built on the domain detail; use orderFromOwnedDomain. */
export function orderFromDomainInfo(fqdn: string, info: DomainDetails | null): DomainOrder {
  if (!info) return orderFromOwnedDomain(fqdn, null);
  const ends = info.dates?.registry_ends_at;
  return orderFromOwnedDomain(fqdn, {
    fqdn,
    status: domainStatusFrom(info.status),
    expiresAt: ends ? new Date(ends) : undefined,
    usesProviderDns: false,
    registryStatus: info.status,
  });
}

/**
 * LiveDNS stores TXT values in zone-file syntax. An unquoted value with spaces
 * (`v=spf1 include:x ~all`) would be split into several strings and glued back
 * without the spaces, so values are quoted, escaped, and split into strings of
 * at most 255 bytes (DKIM keys). Already quoted values are kept.
 */
export function quoteTxtValue(value: string): string {
  let v = value.trim();
  const single = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (single) v = single[1].replace(/\\(.)/g, "$1");
  else if (/^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")+$/.test(v)) return v;
  const chunks: string[] = [];
  let current = "";
  for (const ch of v) {
    if (Buffer.byteLength(current + ch) > 255) {
      chunks.push(current);
      current = "";
    }
    current += ch;
  }
  chunks.push(current);
  return chunks.map((c) => `"${c.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
}

function formatPrice(n: number, currency: string): string {
  return `${n.toFixed(2)} ${currency === "EUR" ? "€" : currency}`;
}

/** Real Gandi v5 implementation: domain availability, registration, LiveDNS records. */
export class GandiProvider implements DomainProvider {
  readonly name = "gandi";
  private readonly client: GandiClient | null;
  private readonly checkCache = new Map<string, { at: number; value: DomainAvailability }>();

  constructor(creds: GandiCredentials | null, fetchImpl?: FetchLike) {
    const apiKey = cleanSecret(creds?.apiKey);
    this.client = apiKey
      ? new GandiClient(apiKey, cleanSecret(creds?.organizationId) || undefined, fetchImpl)
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

  async check(fqdn: string, opts: { fresh?: boolean } = {}): Promise<DomainAvailability> {
    const cached = this.checkCache.get(fqdn);
    if (!opts.fresh && cached && Date.now() - cached.at < CHECK_CACHE_MS) return cached.value;
    const path = `/domain/check?name=${encodeURIComponent(fqdn)}`;
    const [create, renew] = await Promise.all([
      this.api().request<CheckResponse>("GET", path, { sharing: true }),
      // Renewal price, best effort: the `processes` parameter is not confirmed
      // against the live API, and a refusal must not break the check.
      this.api()
        .request<CheckResponse>("GET", `${path}&processes=renew`, { sharing: true })
        .then((r) => r.data)
        .catch(() => null),
    ]);
    const renewProducts = (renew?.products ?? []).filter((p) => p.process === "renew");
    const value = availabilityFromCheck(fqdn, {
      ...create.data,
      products: [...(create.data?.products ?? []), ...renewProducts],
    });
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

  /**
   * Buys a domain, safely:
   * - a domain already in the account is never bought again (resume after a crash or a timeout);
   * - the price is checked again and must not exceed the confirmed one;
   * - a dry run validates the order (contact, premium price) before the real call.
   * Throws when the price changed; returns a "failed" order when Gandi refuses.
   */
  async register(
    fqdn: string,
    contact: DomainContact,
    opts: { expectedPrice?: number; currency?: string } = {},
  ): Promise<DomainOrder> {
    const missing = missingContactFields(contact);
    if (missing.length)
      return {
        orderId: fqdn,
        status: "failed",
        message: `Contact propriétaire incomplet (Paramètres > Agence) : ${missing.join(", ")}`,
      };

    const existing = await this.getDomain(fqdn);
    if (existing) {
      return existing.status === "active"
        ? {
            orderId: fqdn,
            status: "registered",
            expiresAt: existing.expiresAt,
            message: "Domaine déjà présent dans le compte Gandi : aucun nouvel achat.",
          }
        : {
            orderId: fqdn,
            status: "pending",
            message: "Domaine déjà commandé, enregistrement en cours chez Gandi.",
          };
    }

    const availability = await this.check(fqdn, { fresh: true });
    if (!availability.available)
      return {
        orderId: fqdn,
        status: "failed",
        message: `${fqdn} n'est plus disponible : ${availability.reason ?? "refusé par Gandi"}.`,
      };
    const currency = availability.currency ?? "EUR";
    if (opts.currency && opts.currency !== currency)
      throw new Error(
        `Achat de ${fqdn} annulé : Gandi facture en ${currency}, le prix confirmé était en ${opts.currency}.`,
      );
    if (availability.premium && opts.expectedPrice === undefined)
      throw new Error(
        `Achat de ${fqdn} annulé : domaine premium, son prix doit être confirmé explicitement.`,
      );
    if (opts.expectedPrice !== undefined) {
      if (availability.price === undefined)
        throw new Error(
          `Achat de ${fqdn} annulé : Gandi n'a pas renvoyé de prix, impossible de vérifier le montant confirmé.`,
        );
      if (availability.price > opts.expectedPrice + PRICE_EPSILON)
        throw new Error(
          `Achat de ${fqdn} annulé : le prix est passé à ${formatPrice(availability.price, currency)} au lieu de ${formatPrice(opts.expectedPrice, currency)} confirmés. Rien n'a été acheté : confirmez le nouveau prix.`,
        );
    }

    const body: Record<string, unknown> = { fqdn, owner: toGandiOwner(contact), duration: 1 };
    if (availability.premium) {
      // Premium names must carry the quoted price and `enforce_premium`
      // (go-gandi CreateRequest). Whether Gandi compares `price` with or
      // without taxes is not confirmed: the dry run rejects a mismatch, so no
      // purchase can happen at a wrong price.
      body.enforce_premium = true;
      body.price = availability.priceBeforeTaxes ?? availability.price;
      body.currency = currency;
    }

    try {
      const dry = await this.api().request<GandiErrorBody | null>("POST", "/domain/domains", {
        body,
        headers: { "Dry-Run": "1" },
        sharing: true,
        expect: [200, 202],
      });
      // A dry run answers 200 even when the order would fail: read the body.
      const status = dry.data && typeof dry.data === "object" ? dry.data.status : undefined;
      if (status === "error" || (dry.data?.errors?.length ?? 0) > 0) {
        const details =
          dry.data?.errors
            ?.map((e) => [e.name, e.description].filter(Boolean).join(" : "))
            .join(" ; ") ||
          dry.data?.message ||
          "refus sans détail";
        return {
          orderId: fqdn,
          status: "failed",
          message: `Validation refusée avant achat : ${details}.`,
        };
      }
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
      expect: [200, 201, 202],
    });
    return {
      orderId: orderIdFor(fqdn),
      status: "pending",
      message: data?.message ?? "Commande envoyée à Gandi",
    };
  }

  /**
   * Status of an order, read from the domain itself: registered once the
   * registry is done (no pendingCreate), failed when the domain never shows
   * up in the account. Gandi v5 exposes no order or operation endpoint that
   * go-gandi knows of, so a payment refused after the 202 is only detected
   * that way (after 24 h).
   */
  async getOrder(orderId: string): Promise<DomainOrder> {
    const { fqdn } = parseOrderId(orderId);
    const domain = await this.getDomain(fqdn);
    const order = orderFromOwnedDomain(orderId, domain);
    if (order.status === "registered" && domain && !domain.autorenew) {
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
    const d = await this.getDomain(fqdn);
    return d ? { expiresAt: d.expiresAt, autorenew: Boolean(d.autorenew) } : null;
  }

  async getDomain(fqdn: string): Promise<OwnedDomain | null> {
    const name = fqdn.toLowerCase();
    let info: DomainDetails;
    try {
      info = (
        await this.api().request<DomainDetails>(
          "GET",
          `/domain/domains/${encodeURIComponent(name)}`,
          { sharing: true },
        )
      ).data;
    } catch (err) {
      if (err instanceof GandiError && err.status === 404) return null;
      throw err;
    }
    const ends = info.dates?.registry_ends_at;
    return {
      fqdn: info.fqdn ?? name,
      status: domainStatusFrom(info.status),
      expiresAt: ends ? new Date(ends) : undefined,
      usesProviderDns: await this.usesLiveDns(name, info),
      autorenew: autorenewOf(info),
      registryStatus: info.status ?? [],
    };
  }

  private async usesLiveDns(fqdn: string, info: DomainDetails): Promise<boolean> {
    if (info.nameserver?.current) return info.nameserver.current === "livedns";
    try {
      const { data } = await this.api().request<LiveDnsInfo>(
        "GET",
        `/domain/domains/${encodeURIComponent(fqdn)}/livedns`,
        { sharing: true },
      );
      if (data?.current) return data.current === "livedns";
      return looksLikeLiveDns(data?.nameservers ?? info.nameservers);
    } catch (err) {
      if (!(err instanceof GandiError) || err.status === 0) throw err;
      return looksLikeLiveDns(info.nameservers);
    }
  }

  async listOwned(): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      const { data, headers } = await this.api().request<DomainDetails[]>(
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

  /** One PUT per name and type (replaces that rrset only). TXT values are quoted for LiveDNS. */
  async setRecords(zone: string, records: DnsRecord[]): Promise<void> {
    for (const r of records) {
      const values = r.type === "TXT" ? r.values.map(quoteTxtValue) : r.values;
      await this.api().request(
        "PUT",
        `/livedns/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(r.name)}/${r.type}`,
        {
          body: { rrset_ttl: r.ttl ?? 300, rrset_values: values },
          sharing: true,
          expect: [200, 201],
        },
      );
    }
  }

  async deleteRecords(
    zone: string,
    name: string,
    types: DnsRecordType[],
  ): Promise<DnsRecordType[]> {
    const removed: DnsRecordType[] = [];
    for (const type of types) {
      const { status } = await this.api().request(
        "DELETE",
        `/livedns/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(name)}/${type}`,
        { sharing: true, expect: [200, 204, 404] },
      );
      if (status !== 404) removed.push(type);
    }
    return removed;
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
