/**
 * Minimal client for the Resend REST API. The API key never appears in logs
 * or error messages; errors are translated for the settings page and the
 * worker logs.
 */

export const RESEND_API = "https://api.resend.com";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ResendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

type ResendErrorBody = { statusCode?: number; name?: string; message?: string };

export function describeResendError(
  status: number,
  body: ResendErrorBody | null,
  fallback: string,
): string {
  const message = body?.message ?? fallback;
  switch (status) {
    case 401:
      return "Clé API Resend invalide (Paramètres > Intégrations).";
    case 403:
      if (/not verified|domain/i.test(message))
        return `Resend refuse l'expéditeur : ${message}. Configurez et vérifiez le domaine d'envoi (Paramètres > Intégrations > Resend).`;
      return `La clé API Resend n'a pas les droits nécessaires (${message}). Utilisez une clé avec l'accès complet.`;
    case 404:
      return `Ressource introuvable chez Resend : ${message}.`;
    case 422:
      return `Resend a refusé la demande : ${message}.`;
    case 429:
      return "Quota Resend atteint ou trop de requêtes, réessayez dans une minute.";
    default:
      return `Erreur Resend (${status}) : ${message}.`;
  }
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  /** Performs a request and parses JSON. `expect` lists the accepted status codes. */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; expect?: number[] } = {},
  ): Promise<{ status: number; data: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_API + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? "délai dépassé"
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ResendError(`Resend injoignable (${reason}).`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    const accepted = opts.expect ?? [200, 201];
    if (!accepted.includes(res.status)) {
      const body = data && typeof data === "object" ? (data as ResendErrorBody) : null;
      throw new ResendError(
        describeResendError(res.status, body, `${method} ${path}`),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T };
  }
}
