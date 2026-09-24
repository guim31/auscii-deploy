import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // No default in production: a missing APP_URL must not silently disable the checks below.
  APP_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(16),
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "APP_ENCRYPTION_KEY must be 32 bytes in hex (openssl rand -hex 32)"),
  DATA_DIR: z.string().default("./data"),
  /**
   * Origin serving the release previews (e.g. https://apercu.auscii-preview.site).
   * Must not share the tool's registrable domain. Empty in local development:
   * previews are then served by the tool itself.
   */
  PREVIEW_ORIGIN: z
    .string()
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  NODE_ENV: z.string().default("development"),
});

/** Values shipped in .env.example: fine locally, never acceptable on a public host. */
const PLACEHOLDER_ENCRYPTION_KEY = "0".repeat(64);

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);
}

/**
 * Refuses to boot a publicly reachable instance that still carries the example
 * secrets or serves over plain HTTP. Local development is untouched.
 */
export function productionIssues(v: Env): string[] {
  if (isLocalUrl(v.APP_URL)) return [];
  const issues: string[] = [];
  if (v.BETTER_AUTH_SECRET.length < 32)
    issues.push("BETTER_AUTH_SECRET: 32 caractères minimum (openssl rand -hex 32).");
  if (v.PREVIEW_ORIGIN && sameSite(v.PREVIEW_ORIGIN, v.APP_URL))
    issues.push(
      "PREVIEW_ORIGIN: doit être sur un autre domaine que l'outil (ex. apercu.auscii-preview.site), sinon les sites clients partagent ses cookies.",
    );
  if (!v.APP_URL.startsWith("https://"))
    issues.push("APP_URL: le pilote doit être servi en https (Caddy s'en charge).");
  if (/change-me/i.test(v.BETTER_AUTH_SECRET))
    issues.push("BETTER_AUTH_SECRET: valeur d'exemple, générez-en une (openssl rand -hex 32).");
  if (v.APP_ENCRYPTION_KEY.toLowerCase() === PLACEHOLDER_ENCRYPTION_KEY)
    issues.push("APP_ENCRYPTION_KEY: valeur d'exemple, générez-en une (openssl rand -hex 32).");
  return issues;
}

/** Rough registrable-domain comparison (last two labels), enough to catch the obvious mistake. */
function sameSite(a: string, b: string): boolean {
  const site = (u: string) => new URL(u).hostname.split(".").slice(-2).join(".");
  return site(a) === site(b);
}

export type Env = Omit<z.infer<typeof schema>, "APP_URL"> & { APP_URL: string };

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const building = process.env.NEXT_PHASE === "phase-production-build";
    if (!parsed.data.APP_URL && parsed.data.NODE_ENV === "production" && !building)
      throw new Error(
        "Configuration refusée : APP_URL est obligatoire (https://<hôte du pilote>).",
      );
    const value: Env = { ...parsed.data, APP_URL: parsed.data.APP_URL ?? "http://localhost:3000" };
    const issues = productionIssues(value);
    if (issues.length > 0) throw new Error(`Configuration refusée : ${issues.join(" ")}`);
    cached = value;
  }
  return cached;
}
