import { createHash } from "node:crypto";
import {
  type DnsRecord,
  type MailMessage,
  type MailProvider,
  ProviderNotConfiguredError,
} from "../types";
import { cleanSecret } from "../http-utils";
import { ResendClient, type FetchLike } from "./resend-client";

export type ResendCredentials = { apiKey: string; from?: string };

export type ResendProviderOptions = {
  /**
   * Sender used when neither the message nor the settings give one:
   * `defaultSender(agencyName, techDomain)`, set by getProviders().
   */
  defaultFrom?: string;
};

export type SendingDomainStatus =
  "not_started" | "pending" | "verified" | "failed" | "temporary_failure";

export type SendingDomain = {
  id: string;
  name: string;
  /** Readiness for sending (partial states are resolved from the SPF/DKIM records). */
  status: SendingDomainStatus;
  /** Status as returned by Resend, e.g. `partially_verified`. */
  rawStatus?: string;
  /** DNS records Resend asks for, relative to the domain (`@` for the apex). */
  records: DnsRecord[];
};

type ApiRecord = {
  record?: string;
  name?: string;
  type?: string;
  ttl?: string | number;
  value?: string;
  priority?: number;
  status?: string;
};

type ApiDomain = {
  id: string;
  name: string;
  status?: string;
  region?: string;
  records?: ApiRecord[];
};

const REGION = "eu-west-1";
/** Resend refuses longer idempotency keys. */
const MAX_IDEMPOTENCY_KEY = 256;

/** Sender used when the settings leave the "from" field empty. */
export function defaultSender(agencyName: string, techDomain: string): string {
  return `${agencyName} <no-reply@${techDomain}>`;
}

/**
 * Maps Resend's domain status (resend-node DomainStatus) to readiness for
 * sending. `partially_verified` / `partially_failed` mean that some records
 * are verified: sending works as soon as the SPF and DKIM records are, the
 * others (inbound MX, tracking) do not matter here.
 */
export function statusOf(raw: string | undefined, records?: ApiRecord[]): SendingDomainStatus {
  switch (raw) {
    case "verified":
    case "pending":
    case "failed":
    case "temporary_failure":
      return raw;
    case "partially_verified":
    case "partially_failed": {
      const sending = (records ?? []).filter((r) => r.record === "SPF" || r.record === "DKIM");
      if (sending.length > 0 && sending.every((r) => r.status === "verified")) return "verified";
      return raw === "partially_failed" ? "failed" : "pending";
    }
    default:
      return "not_started";
  }
}

/** Converts the records returned by Resend into zone-relative DnsRecords for LiveDNS. */
export function recordsFromResend(domain: ApiDomain): DnsRecord[] {
  const out = new Map<string, DnsRecord>();
  for (const r of domain.records ?? []) {
    const type = (r.type ?? "").toUpperCase();
    if (!r.value || !["TXT", "MX", "CNAME"].includes(type)) continue;
    let name = (r.name ?? "").trim();
    if (name.endsWith(`.${domain.name}`)) name = name.slice(0, -(domain.name.length + 1));
    if (name === "" || name === domain.name) name = "@";
    const value =
      type === "MX"
        ? `${r.priority ?? 10} ${r.value.endsWith(".") ? r.value : `${r.value}.`}`
        : type === "CNAME"
          ? r.value.endsWith(".")
            ? r.value
            : `${r.value}.`
          : r.value;
    const key = `${name}/${type}`;
    const existing = out.get(key);
    if (existing) existing.values.push(value);
    else
      out.set(key, {
        name,
        type: type as DnsRecord["type"],
        values: [value],
        ttl: Number(r.ttl) > 0 ? Number(r.ttl) : 300,
      });
  }
  return [...out.values()];
}

function toSendingDomain(domain: ApiDomain): SendingDomain {
  return {
    id: domain.id,
    name: domain.name,
    status: statusOf(domain.status, domain.records),
    ...(domain.status ? { rawStatus: domain.status } : {}),
    records: recordsFromResend(domain),
  };
}

/** Resend accepts keys up to 256 characters: longer ones are hashed (same key, same hash). */
export function idempotencyHeader(key: string): string {
  return key.length <= MAX_IDEMPOTENCY_KEY
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/** Real Resend implementation: transactional emails plus sending-domain management. */
export class ResendProvider implements MailProvider {
  readonly name = "resend";
  private readonly apiKey: string;
  private readonly from: string;

  constructor(
    creds: ResendCredentials | null,
    private readonly fetchImpl?: FetchLike,
    private readonly options: ResendProviderOptions = {},
  ) {
    this.apiKey = cleanSecret(creds?.apiKey);
    this.from = (creds?.from ?? "").trim();
  }

  private api(): ResendClient {
    if (!this.apiKey)
      throw new ProviderNotConfiguredError(
        "Resend",
        "Clé API Resend manquante (Paramètres > Intégrations).",
      );
    return new ResendClient(this.apiKey, this.fetchImpl);
  }

  /** Sender actually used: the message's, else the configured one, else the agency default. */
  senderFor(message: Pick<MailMessage, "from">): string | undefined {
    return message.from?.trim() || this.from || this.options.defaultFrom?.trim() || undefined;
  }

  async send(message: MailMessage): Promise<{ id: string }> {
    const from = this.senderFor(message);
    if (!from)
      throw new ProviderNotConfiguredError(
        "Resend",
        "Expéditeur Resend manquant (Paramètres > Intégrations > Resend).",
      );
    const res = await this.api().request<{ id: string }>("POST", "/emails", {
      body: {
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      },
      headers: message.idempotencyKey
        ? { "Idempotency-Key": idempotencyHeader(message.idempotencyKey) }
        : undefined,
    });
    return { id: res.data.id };
  }

  /** Domains declared on the Resend account. */
  async listDomains(): Promise<SendingDomain[]> {
    const res = await this.api().request<{ data?: ApiDomain[] }>("GET", "/domains");
    return (res.data.data ?? []).map(toSendingDomain);
  }

  /** Full detail of one domain, including the DNS records Resend expects. */
  async getDomain(id: string): Promise<SendingDomain> {
    const res = await this.api().request<ApiDomain>("GET", `/domains/${encodeURIComponent(id)}`);
    return toSendingDomain(res.data);
  }

  /** Declares the domain on Resend if needed and returns it with its records. Idempotent. */
  async ensureSendingDomain(name: string): Promise<SendingDomain> {
    const existing = (await this.listDomains()).find(
      (d) => d.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return this.getDomain(existing.id);
    const res = await this.api().request<ApiDomain>("POST", "/domains", {
      body: { name, region: REGION },
    });
    return toSendingDomain(res.data);
  }

  /** Asks Resend to check the DNS records, then returns the refreshed status. */
  async verifyDomain(id: string): Promise<SendingDomain> {
    await this.api().request("POST", `/domains/${encodeURIComponent(id)}/verify`);
    return this.getDomain(id);
  }

  /** Used by the settings "Tester" button. */
  async whoAmI(): Promise<{ domains: SendingDomain[] }> {
    return { domains: await this.listDomains() };
  }
}
