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
  /** Registration price for the first year, when available. */
  price?: number;
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

export type DnsRecord = {
  name: string;
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX";
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
};

export interface DomainProvider {
  readonly name: string;
  check(fqdn: string): Promise<DomainAvailability>;
  suggest(base: string): Promise<DomainAvailability[]>;
  register(fqdn: string, contact: DomainContact): Promise<DomainOrder>;
  getOrder(orderId: string): Promise<DomainOrder>;
  listOwned(): Promise<string[]>;
  /** Creates or replaces the given records in the zone. */
  setRecords(zone: string, records: DnsRecord[]): Promise<void>;
}

// ---------- Cloud (Scaleway) ----------

export type ServerOffer = {
  id: string;
  vcpus: number;
  ramGb: number;
  diskGb: number;
  monthlyPrice: number;
  currency: string;
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

export interface CloudProvider {
  readonly name: string;
  listOffers(zone: string): Promise<ServerOffer[]>;
  createServer(input: {
    name: string;
    offer: string;
    zone: string;
    cloudInit: string;
  }): Promise<CloudServer>;
  getServer(providerId: string, zone: string): Promise<CloudServer>;
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
  /** Merges staging into production and tags the result. */
  promote(input: { repo: string; tag: string }): Promise<{ commitSha: string; tag: string }>;
}

// ---------- Mail (Resend) ----------

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
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
  uploadRelease(
    server: ServerRef,
    slug: string,
    releaseDir: string,
    releaseName: string,
  ): Promise<void>;
  switchRelease(server: ServerRef, slug: string, releaseName: string): Promise<void>;
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
