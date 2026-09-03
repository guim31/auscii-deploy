import {
  type DnsRecord,
  type MailMessage,
  type MailProvider,
  ProviderNotConfiguredError,
} from "../types";
import { ResendClient, type FetchLike } from "./resend-client";

export type ResendCredentials = { apiKey: string; from?: string };

export type SendingDomainStatus =
  "not_started" | "pending" | "verified" | "failed" | "temporary_failure";

export type SendingDomain = {
  id: string;
  name: string;
  status: SendingDomainStatus;
  /** DNS records Resend asks for, relative to the domain (`@` for the apex). */
  records: DnsRecord[];
};

type ApiDomain = {
  id: string;
  name: string;
  status?: string;
  region?: string;
  records?: {
    record?: string;
    name?: string;
    type?: string;
    ttl?: string | number;
    value?: string;
    priority?: number;
    status?: string;
  }[];
};

const REGION = "eu-west-1";

/** Sender used when the settings leave the "from" field empty. */
export function defaultSender(agencyName: string, techDomain: string): string {
  return `${agencyName} <no-reply@${techDomain}>`;
}

function statusOf(raw: string | undefined): SendingDomainStatus {
  switch (raw) {
    case "verified":
    case "pending":
    case "failed":
    case "temporary_failure":
      return raw;
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
    status: statusOf(domain.status),
    records: recordsFromResend(domain),
  };
}

/** Real Resend implementation: transactional emails plus sending-domain management. */
export class ResendProvider implements MailProvider {
  readonly name = "resend";

  constructor(
    private readonly creds: ResendCredentials | null,
    private readonly fetchImpl?: FetchLike,
  ) {}

  private api(): ResendClient {
    if (!this.creds?.apiKey)
      throw new ProviderNotConfiguredError(
        "Resend",
        "Clé API Resend manquante (Paramètres > Intégrations).",
      );
    return new ResendClient(this.creds.apiKey, this.fetchImpl);
  }

  async send(message: MailMessage): Promise<{ id: string }> {
    const from = message.from ?? this.creds?.from;
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
