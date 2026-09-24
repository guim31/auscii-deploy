import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "../env";

/**
 * Contract between the Caddy blocks of the site servers and the pilot's
 * /api/forms route. The site server proves the request comes from it with a
 * per-site secret derived from APP_ENCRYPTION_KEY: nothing to store, and a
 * leaked site block only exposes the sites of that server.
 */
export const RELAY_HEADERS = {
  /** Per-site secret, see relaySecretFor(). */
  secret: "X-Auscii-Relay",
  /** Slug of the site (never the "--preview" folder name). */
  site: "X-Site",
  /** "preview" on the preproduction block, stripped from client requests on production. */
  env: "X-Site-Env",
  /** Visitor IP as seen by the site server ({remote_host}). */
  clientIp: "X-Auscii-Client-Ip",
  /** Host the visitor posted to ({host}), for relative redirects and logs. */
  siteHost: "X-Auscii-Site-Host",
} as const;

function relayKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env().APP_ENCRYPTION_KEY, "hex"),
      Buffer.alloc(0),
      "auscii-forms-relay",
      32,
    ),
  );
}

/** Secret written in the Caddy block of a site; 32 hex characters, safe in a Caddyfile. */
export function relaySecretFor(siteSlug: string): string {
  return createHmac("sha256", relayKey()).update(siteSlug).digest("hex").slice(0, 32);
}

export function verifyRelaySecret(siteSlug: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(relaySecretFor(siteSlug));
  const given = Buffer.from(provided);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
