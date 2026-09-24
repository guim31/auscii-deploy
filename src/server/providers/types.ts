/**
 * Provider interfaces. Every external integration is described here and has
 * two implementations: a real one (filled in phases 2 to 7) and a mock used by
 * the demo mode and the test suite.
 */

export class ProviderNotConfiguredError extends Error {
  constructor(
    public readonly provider: string,
    message?: string,
  ) {
    super(message ?? `Le fournisseur ${provider} n'est pas configuré.`);
    this.name = "ProviderNotConfiguredError";
  }
}

// ---------- Domains (Gandi) ----------

export type DomainAvailability = {
  fqdn: string;
  available: boolean;
  /** Registration price for the first year (taxes included), when available. May be a promotion. */
  price?: number;
  /** Same price before taxes, as the registrar bills it. */
  priceBeforeTaxes?: number;
  /** Yearly renewal price (taxes included), when the registrar returns it; differs from `price` during promotions. */
  renewPrice?: number;
  currency?: string;
  premium?: boolean;
  reason?: string;
};

export type DomainOrder = {
  orderId: string;
  status: "pending" | "registered" | "failed";
  expiresAt?: Date;
  message?: string;
};

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "ALIAS" | "TXT" | "MX";

export type DnsRecord = {
  name: string;
  type: DnsRecordType;
  values: string[];
  ttl?: number;
};

/** Legal owner of a purchased domain (the agency). */
export type DomainContact = {
  organizationId?: string;
  email: string;
  orgName?: string;
  givenName?: string;
  familyName?: string;
  phone?: string;
  street?: string;
  zip?: string;
  city?: string;
  /** ISO 3166-1 alpha-2, e.g. FR */
  country?: string;
  /** French company number (SIREN, 9 digits): identifies a company owner of a .fr domain at AFNIC. */
  siren?: string;
};

/** A domain already present in the registrar account. */
export type OwnedDomain = {
  fqdn: string;
  /** "active" once registered and usable, "pending" while the registry processes it. */
  status: "active" | "pending" | "other";
  expiresAt?: Date;
  /** true when the domain is served by the registrar's DNS (LiveDNS), so records can be written. */
  usesProviderDns: boolean;
  /** Automatic renewal state, when known. */
  autorenew?: boolean;
  /** Raw registry statuses (EPP), for messages. */
  registryStatus?: string[];
};

export interface DomainProvider {
  readonly name: string;
  check(fqdn: string): Promise<DomainAvailability>;
  suggest(base: string): Promise<DomainAvailability[]>;
  /**
   * Buys the domain. `expectedPrice` is the price the admin confirmed: the
   * provider refuses to buy above it, and passes it along for premium names.
   */
  register(
    fqdn: string,
    contact: DomainContact,
    opts?: { expectedPrice?: number; currency?: string },
  ): Promise<DomainOrder>;
  getOrder(orderId: string): Promise<DomainOrder>;
  /** The domain as seen in the account, or null when the account does not hold it. */
  getDomain(fqdn: string): Promise<OwnedDomain | null>;
  listOwned(): Promise<string[]>;
  /** Creates or replaces the given records in the zone (one rrset per name and type). */
  setRecords(zone: string, records: DnsRecord[]): Promise<void>;
  /** Deletes the rrsets of the given types for a name; missing ones are ignored. Returns the types actually removed. */
  deleteRecords(zone: string, name: string, types: DnsRecordType[]): Promise<DnsRecordType[]>;
}

// ---------- Cloud (Scaleway) ----------

export type ServerOffer = {
  id: string;
  vcpus: number;
  ramGb: number;
  /** Root volume size the tool creates for this offer. */
  diskGb: number;
  /** Estimated monthly total before taxes: instance, plus public IPv4 and root volume when billed apart (see priceBreakdown). */
  monthlyPrice: number;
  currency: string;
  /** Parts of monthlyPrice; a missing part is not included in the total. */
  priceBreakdown?: { instance: number; ipv4?: number; volume?: number };
  /** CPU architecture, e.g. x86_64 or arm64. */
  arch?: string;
  /** Root volume kind: local SSD, or block storage billed separately. */
  storage?: "l_ssd" | "sbs_volume";
};

export type CloudServer = {
  providerId: string;
  name: string;
  zone: string;
  state: "starting" | "running" | "stopped" | "error";
  ip?: string;
  /** Provider resources attached to the instance (IP, volumes), kept for deletion. */
  metadata?: Record<string, unknown>;
};

/**
 * Thrown by createServer when the instance exists at the provider (onCreated
 * already ran with `server`) but a later step failed: cloud-init, power-on, or
 * onCreated itself. The instance is billed: keep `server.providerId`.
 */
export class ServerOrderIncompleteError extends Error {
  constructor(
    message: string,
    public readonly server: CloudServer,
  ) {
    super(message);
    this.name = "ServerOrderIncompleteError";
  }
}

export interface CloudProvider {
  readonly name: string;
  listOffers(zone: string): Promise<ServerOffer[]>;
  /**
   * Orders an instance of exactly `offer` (never a substitute: throws when the
   * offer is unavailable). `onCreated` runs as soon as the instance exists at
   * the provider, before cloud-init and power-on, so the caller can persist its
   * id: a later failure then never leaves a billed instance unknown to the tool.
   * A failure after the instance exists throws ServerOrderIncompleteError.
   * Idempotent by name: when an instance created by the tool already has this
   * name in the zone (an interrupted order), it is adopted and finished instead
   * of ordering a second one. Names must therefore never be reused.
   */
  createServer(
    input: {
      name: string;
      offer: string;
      zone: string;
      cloudInit: string;
    },
    hooks?: { onCreated?: (server: CloudServer) => Promise<void> },
  ): Promise<CloudServer>;
  getServer(providerId: string, zone: string): Promise<CloudServer>;
  /** Finds an instance created by the tool under this name, to resume an interrupted order. */
  findServerByName(name: string, zone: string): Promise<CloudServer | null>;
  deleteServer(providerId: string, zone: string, metadata?: Record<string, unknown>): Promise<void>;
}

// ---------- Git (GitHub) ----------

export type GitBranch = "staging" | "production";

export interface GitProvider {
  readonly name: string;
  createRepo(slug: string): Promise<{ fullName: string; url: string }>;
  pushRelease(input: {
    repo: string;
    releaseDir: string;
    branch: GitBranch;
    message: string;
  }): Promise<{ commitSha: string }>;
  /** Moves production to the staging head (or to commitSha) and tags the result. */
  promote(input: {
    repo: string;
    tag: string;
    commitSha?: string;
  }): Promise<{ commitSha: string; tag: string }>;
}

// ---------- Mail (Resend) ----------

export type MailMessage = {
  to: string;
  /** Overrides the sender configured in the integration settings. */
  from?: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Same key, same email: a retried send after a timeout is not delivered twice. */
  idempotencyKey?: string;
};

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<{ id: string }>;
}

// ---------- AI (Anthropic) ----------

export type Finding = { level: "ok" | "info" | "warn"; message: string };

export type AiReport = {
  summary: string;
  seo: Finding[];
  accessibility: Finding[];
  content: Finding[];
  generatedBy: string;
};

export type AiSiteInput = {
  clientName: string;
  files: { path: string; size: number }[];
  pages: { path: string; title?: string; text: string }[];
  /** Findings of the automatic analysis, so the report completes them instead of repeating them. */
  facts?: string[];
};

export interface AiProvider {
  readonly name: string;
  analyzeSite(input: AiSiteInput): Promise<AiReport>;
}

// ---------- Server agent (SSH) ----------

export type ServerRef = {
  id: string;
  name: string;
  ip: string | null;
  sshUser: string;
  vcpus: number;
};

export type ServerMetrics = {
  load15: number;
  vcpus: number;
  ramUsedPct: number;
  diskUsedPct: number;
  diskFreeBytes: number;
  sitesCount: number;
  collectedAt: string;
};

export type TlsCheck = {
  host: string;
  ok: boolean;
  issuer?: string;
  expiresAt?: Date;
  error?: string;
};

export interface ServerAgent {
  readonly name: string;
  /** Waits for SSH and checks Caddy is installed. */
  waitReady(server: ServerRef, timeoutMs: number): Promise<void>;
  exec(
    server: ServerRef,
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  ensureSiteDirs(server: ServerRef, slug: string): Promise<void>;
  /**
   * Sends a release. Releases are immutable: an already complete release is
   * left untouched (never deleted and re-extracted, it may be the live one).
   */
  uploadRelease(
    server: ServerRef,
    slug: string,
    releaseDir: string,
    releaseName: string,
  ): Promise<void>;
  /** true when the release is fully present on the server (a rollback can switch to it). */
  hasRelease(server: ServerRef, slug: string, releaseName: string): Promise<boolean>;
  switchRelease(server: ServerRef, slug: string, releaseName: string): Promise<void>;
  /** Deletes the releases of a site except `keep` and the one `current` points to. Returns the deleted names. */
  pruneReleases(server: ServerRef, slug: string, keep: string[]): Promise<string[]>;
  /**
   * Installs a site block safely: validates it with the other blocks and keeps
   * the previous working file when validation fails (throws in that case).
   */
  writeCaddySite(server: ServerRef, slug: string, config: string): Promise<void>;
  removeCaddySite(server: ServerRef, slug: string): Promise<void>;
  reloadCaddy(server: ServerRef): Promise<void>;
  collectMetrics(server: ServerRef): Promise<ServerMetrics>;
  checkTls(host: string): Promise<TlsCheck>;
}

// ---------- Screenshots ----------

export interface ScreenshotProvider {
  readonly name: string;
  /** Captures the given URL and writes an image at outPath. Returns the file extension used. */
  capture(url: string, outPath: string, label: string): Promise<"png" | "svg">;
}

export type Providers = {
  demo: boolean;
  domain: DomainProvider;
  cloud: CloudProvider;
  git: GitProvider;
  mail: MailProvider;
  ai: AiProvider;
  agent: ServerAgent;
  screenshot: ScreenshotProvider;
};
