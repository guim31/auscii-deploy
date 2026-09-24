/**
 * Shared plumbing for the REST clients of the real providers (Gandi,
 * Scaleway, GitHub, Resend): credential hygiene, secret-free error messages,
 * timeouts and retries of idempotent reads.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MASK = "***";

/** Trims a credential pasted in the settings (spaces or a final newline are common). */
export function cleanSecret(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * true when a secret cannot travel in an HTTP header. Node's fetch then throws
 * a TypeError whose message contains the whole header, secret included.
 */
export function hasForbiddenHeaderChars(value: string): boolean {
  // Control characters (inner newline, tab…), DEL, and anything outside latin-1.
  return /[\u0000-\u001f\u007f]|[^\u0000-ÿ]/.test(value);
}

/** French message for a secret that fails `hasForbiddenHeaderChars`. */
export function invalidSecretMessage(label: string): string {
  return `${label} contient un retour à la ligne ou un caractère invalide : collez-la de nouveau, sur une seule ligne (Paramètres > Intégrations).`;
}

/**
 * Removes secrets from a message: the given values (and their base64 form,
 * used in basic auth headers), plus anything that looks like a bearer token,
 * a basic auth header or credentials in a URL.
 */
export function sanitizeMessage(
  message: string,
  secrets: (string | null | undefined)[] = [],
): string {
  let out = message;
  for (const raw of secrets) {
    const secret = (raw ?? "").trim();
    if (secret.length < 6) continue;
    const variants = new Set<string>([secret]);
    for (const line of secret.split(/\r?\n/))
      if (line.trim().length >= 6) variants.add(line.trim());
    variants.add(Buffer.from(secret).toString("base64"));
    variants.add(Buffer.from(`x-access-token:${secret}`).toString("base64"));
    for (const v of variants) out = out.split(v).join(MASK);
  }
  return out
    .replace(/\b(Bearer|basic)\s+[^\s"',;]+/gi, `$1 ${MASK}`)
    .replace(/(X-Auth-Token["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1${MASK}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/x-access-token:[^\s@"']+/gi, `x-access-token:${MASK}`);
}

/**
 * Short, secret-free reason for a failed fetch (network error, timeout,
 * invalid header). Never copies the message of a header TypeError: it quotes
 * the header value.
 */
export function networkErrorReason(
  err: unknown,
  secrets: (string | null | undefined)[] = [],
): string {
  if (!(err instanceof Error)) return "erreur réseau";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "délai dépassé";
  if (/header|Headers\./i.test(err.message))
    return "en-tête d'authentification refusé, la clé contient probablement un caractère invalide";
  const cause = (err as Error & { cause?: unknown }).cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  const base = code ? `${err.message} (${code})` : err.message;
  return sanitizeMessage(base, secrets);
}

export type RetryOptions = {
  /** Total attempts for idempotent reads (GET/HEAD). Writes are never retried. */
  attempts?: number;
  /** Base delay, multiplied by 3 at each attempt. 0 in tests. */
  baseDelayMs?: number;
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultBaseDelay(): number {
  return process.env.NODE_ENV === "test" ? 0 : 500;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 10_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 10_000) : null;
}

/** Thrown by `fetchWithRetry` when no response came back. `reason` is secret-free. */
export class NetworkError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "NetworkError";
  }
}

/**
 * fetch with a per-attempt timeout. GET and HEAD are retried with backoff on
 * 429, 5xx and network errors; other methods are sent once (a retried POST
 * could buy twice).
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; secrets?: (string | null | undefined)[] } & RetryOptions,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const attempts = idempotent ? Math.max(1, opts.attempts ?? 3) : 1;
  const base = opts.baseDelayMs ?? defaultBaseDelay();
  let lastReason = "erreur réseau";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastReason = networkErrorReason(err, opts.secrets);
      // A header error will fail the same way every time.
      if (/en-tête/.test(lastReason)) break;
    } finally {
      clearTimeout(timer);
    }
    if (res) {
      if (attempt < attempts && RETRYABLE_STATUS.has(res.status)) {
        const wait = retryAfterMs(res) ?? base * 3 ** (attempt - 1);
        await res.text().catch(() => undefined);
        await sleep(base === 0 ? 0 : wait);
        continue;
      }
      return res;
    }
    if (attempt < attempts) await sleep(base * 3 ** (attempt - 1));
  }
  throw new NetworkError(lastReason);
}

/** Reads a response body as JSON when possible, as text otherwise. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
