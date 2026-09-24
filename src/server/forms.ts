import { RELAY_HEADERS, verifyRelaySecret } from "./deploy/relay";

/** Limits of what a contact form may send: it comes from the Internet. */
export const FORM_LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxFields: 30,
  maxKeyLength: 64,
  maxValueLength: 5000,
  maxTotalChars: 20_000,
};

export const HONEYPOT_FIELD = "_gotcha";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export type RelayInfo = {
  slug: string;
  env: "production" | "preview";
  clientIp: string;
  siteHost: string | null;
};

/**
 * Authenticates a request relayed by a site server. The pilot is public: without
 * the per-site secret written in the site's Caddy block, anyone could post in the
 * name of any site (spam through the agency's sending domain).
 */
export function readRelay(headers: Headers): RelayInfo | null {
  const slug = headers.get(RELAY_HEADERS.site) ?? "";
  if (!SLUG.test(slug)) return null;
  if (!verifyRelaySecret(slug, headers.get(RELAY_HEADERS.secret))) return null;
  const clientIp = (headers.get(RELAY_HEADERS.clientIp) ?? "").trim().slice(0, 64) || "inconnue";
  const siteHost = (headers.get(RELAY_HEADERS.siteHost) ?? "").trim().slice(0, 253) || null;
  return {
    slug,
    env: headers.get(RELAY_HEADERS.env) === "preview" ? "preview" : "production",
    clientIp,
    siteHost,
  };
}

export type ParsedForm =
  | { ok: true; fields: Record<string, string>; redirect: string | null; honeypot: boolean }
  | { ok: false; status: number; error: string };

/** Parses and bounds the body of a submission (JSON object or form encoding). */
export function parseFormBody(body: string, contentType: string): ParsedForm {
  if (Buffer.byteLength(body) > FORM_LIMITS.maxBodyBytes)
    return { ok: false, status: 413, error: "Message trop long" };
  let entries: [string, unknown][];
  if (contentType.includes("application/json")) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, error: "Message illisible" };
    }
    if (typeof json !== "object" || json === null || Array.isArray(json))
      return { ok: false, status: 400, error: "Message illisible" };
    entries = Object.entries(json);
  } else if (contentType.includes("application/x-www-form-urlencoded") || contentType === "") {
    entries = [...new URLSearchParams(body).entries()];
  } else {
    return { ok: false, status: 415, error: "Format de message non pris en charge" };
  }
  if (entries.length > FORM_LIMITS.maxFields + 5)
    return { ok: false, status: 413, error: "Trop de champs" };

  const raw: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    raw[k] = String(v);
  }
  const honeypot = Boolean(raw[HONEYPOT_FIELD]?.trim());
  const redirect = safeRedirect(raw._redirect);
  const fields: Record<string, string> = {};
  let total = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    const key = k.slice(0, FORM_LIMITS.maxKeyLength);
    const value = v.slice(0, FORM_LIMITS.maxValueLength);
    total += key.length + value.length;
    fields[key] = value;
  }
  if (Object.keys(fields).length > FORM_LIMITS.maxFields)
    return { ok: false, status: 413, error: "Trop de champs" };
  if (total > FORM_LIMITS.maxTotalChars)
    return { ok: false, status: 413, error: "Message trop long" };
  if (!honeypot && Object.values(fields).every((v) => !v.trim()))
    return { ok: false, status: 400, error: "Message vide" };
  return { ok: true, fields, redirect, honeypot };
}

/** A same-site path to send the visitor to after posting ("/merci.html"), or null. */
export function safeRedirect(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^\/(?![/\\])/.test(value)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.length > 512) return null;
  return value;
}

const WINDOW_MS = 10 * 60 * 1000;
const PER_VISITOR = 5;
const PER_SITE = 60;
const hits = new Map<string, number[]>();

function hit(key: string, max: number, now: number): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= max) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  return false;
}

/**
 * In-memory rate limit per visitor (IP reported by the site server) and per
 * site. Old entries are purged so the map cannot grow without bound.
 */
export function formRateLimited(slug: string, clientIp: string, now = Date.now()): boolean {
  if (hits.size > 10_000) {
    for (const [k, list] of hits) if (list.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return hit(`site:${slug}`, PER_SITE, now) || hit(`visitor:${slug}:${clientIp}`, PER_VISITOR, now);
}

export function _resetFormRateLimit() {
  hits.clear();
}
