/**
 * Minimal client for the Gandi v5 REST API. The token never appears in logs
 * or error messages; errors are translated for the deployment console.
 */

import {
  cleanSecret,
  fetchWithRetry,
  hasForbiddenHeaderChars,
  invalidSecretMessage,
  NetworkError,
  networkErrorReason,
  readBody,
  sanitizeMessage,
  type FetchLike,
  type RetryOptions,
} from "../http-utils";

export const GANDI_API = "https://api.gandi.net/v5";

export type { FetchLike };

export class GandiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GandiError";
  }
}

export type GandiErrorBody = {
  /** "success" or "error": a dry run answers 200 in both cases. */
  status?: string;
  code?: number;
  message?: string;
  object?: string;
  cause?: string;
  errors?: { description?: string; name?: string; location?: string }[];
};

export function describeGandiError(
  status: number,
  body: GandiErrorBody | null,
  fallback: string,
): string {
  const details = body?.errors
    ?.map((e) => [e.name, e.description].filter(Boolean).join(" : "))
    .filter(Boolean)
    .join(" ; ");
  const message = body?.message ?? fallback;
  switch (status) {
    case 401:
      return "Jeton Gandi invalide ou expiré (Paramètres > Intégrations).";
    case 403:
      return `Le jeton Gandi n'a pas les droits nécessaires (${message}). Vérifiez les permissions du jeton et l'organisation.`;
    case 402:
      return `Paiement refusé par Gandi : ${message}. Vérifiez le moyen de paiement ou le prépaiement du compte.`;
    case 404:
      return `Ressource introuvable chez Gandi : ${message}.`;
    case 409:
      return `Conflit chez Gandi : ${message}.`;
    case 429:
      return "Trop de requêtes vers Gandi, réessayez dans une minute.";
    default:
      if (status === 400 && details) return `Gandi a refusé la demande : ${details}.`;
      return `Erreur Gandi (${status}) : ${message}.`;
  }
}

export class GandiClient {
  private readonly token: string;

  constructor(
    token: string,
    private readonly organizationId: string | undefined,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
    private readonly retry: RetryOptions = {},
  ) {
    this.token = cleanSecret(token);
  }

  /** Performs a request and parses JSON. `expect` lists the accepted status codes. GETs are retried on 429/5xx. */
  async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      sharing?: boolean;
      expect?: number[];
    } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    if (hasForbiddenHeaderChars(this.token))
      throw new GandiError(invalidSecretMessage("La clé API Gandi"), 0);
    const url = new URL(GANDI_API + path);
    if (opts.sharing && this.organizationId)
      url.searchParams.set("sharing_id", this.organizationId);
    let res: Response;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        url.toString(),
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        { timeoutMs: this.timeoutMs, secrets: [this.token], ...this.retry },
      );
    } catch (err) {
      const reason =
        err instanceof NetworkError ? err.reason : networkErrorReason(err, [this.token]);
      throw new GandiError(`Gandi injoignable (${reason}).`, 0);
    }
    const data = await readBody(res);
    const accepted = opts.expect ?? [200, 201, 202, 204];
    if (!accepted.includes(res.status)) {
      const body = data && typeof data === "object" ? (data as GandiErrorBody) : null;
      throw new GandiError(
        sanitizeMessage(describeGandiError(res.status, body, `${method} ${path}`), [this.token]),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
