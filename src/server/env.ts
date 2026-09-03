import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(16),
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "APP_ENCRYPTION_KEY must be 32 bytes in hex (openssl rand -hex 32)"),
  DATA_DIR: z.string().default("./data"),
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
  if (!v.APP_URL.startsWith("https://"))
    issues.push("APP_URL: le pilote doit être servi en https (Caddy s'en charge).");
  if (/change-me/i.test(v.BETTER_AUTH_SECRET))
    issues.push("BETTER_AUTH_SECRET: valeur d'exemple, générez-en une (openssl rand -hex 32).");
  if (v.APP_ENCRYPTION_KEY.toLowerCase() === PLACEHOLDER_ENCRYPTION_KEY)
    issues.push("APP_ENCRYPTION_KEY: valeur d'exemple, générez-en une (openssl rand -hex 32).");
  return issues;
}

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const issues = productionIssues(parsed.data);
    if (issues.length > 0) throw new Error(`Configuration refusée : ${issues.join(" ")}`);
    cached = parsed.data;
  }
  return cached;
}
