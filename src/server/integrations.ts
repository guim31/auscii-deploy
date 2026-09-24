import "server-only";
import { loadCredentials, type IntegrationName } from "./providers";

/** Fields that are secrets: never sent back to the browser, kept when left empty on save. */
export const SECRET_FIELDS: Record<IntegrationName, string[]> = {
  gandi: ["apiKey"],
  scaleway: ["secretKey"],
  github: ["privateKey"],
  resend: ["apiKey"],
  anthropic: ["apiKey"],
  ssh: ["privateKey"],
};

/** Fields whose value may span lines (PEM keys); every other secret is a single token. */
const MULTILINE_FIELDS = new Set(["privateKey", "publicKey"]);

/** Saved non-secret values of an integration (organisation, identifiers, sender…). */
export async function publicIntegrationValues(
  name: IntegrationName,
): Promise<Record<string, string>> {
  const creds = (await loadCredentials(name)) as Record<string, string> | null;
  if (!creds) return {};
  return Object.fromEntries(
    Object.entries(creds).filter(
      ([k, v]) => !SECRET_FIELDS[name].includes(k) && typeof v === "string",
    ),
  );
}

/**
 * Merges the submitted fields into the saved ones: an empty secret keeps the
 * saved secret, an emptied plain field is removed. Values are trimmed; a
 * single-line value containing spaces or line breaks is refused (a pasted key
 * with a line break would otherwise end up, in clear, in an HTTP error).
 */
export function mergeIntegrationFields(
  name: IntegrationName,
  saved: Record<string, string> | null,
  submitted: Record<string, string>,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const out: Record<string, string> = { ...(saved ?? {}) };
  for (const [key, raw] of Object.entries(submitted)) {
    const value = raw.trim();
    const secret = SECRET_FIELDS[name].includes(key);
    if (!value) {
      if (!secret) delete out[key];
      continue;
    }
    if (!MULTILINE_FIELDS.has(key) && /\s/.test(value) && key !== "from")
      return {
        ok: false,
        error: `Le champ ${key} ne doit contenir ni espace ni retour à la ligne.`,
      };
    if (value.length > 20_000) return { ok: false, error: `Le champ ${key} est trop long.` };
    out[key] = MULTILINE_FIELDS.has(key) ? `${value}\n` : value;
  }
  return { ok: true, values: out };
}
