/**
 * Minimal client for the Resend REST API. The API key never appears in logs
 * or error messages; errors are translated for the settings page and the
 * worker logs.
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

export const RESEND_API = "https://api.resend.com";

export type { FetchLike };

export class ResendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ResendError";
  }

  /** Resend error name (`restricted_api_key`, `validation_error`…), when given. */
  get code(): string | undefined {
    const d = this.details;
    return d && typeof d === "object" && "name" in d
      ? String((d as { name: unknown }).name)
      : undefined;
  }
}

type ResendErrorBody = { statusCode?: number; name?: string; message?: string };

/** Error names from resend-node (RESEND_ERROR_CODE_KEY) are tested before the status. */
export function describeResendError(
  status: number,
  body: ResendErrorBody | null,
  fallback: string,
): string {
  const message = body?.message ?? fallback;
  switch (body?.name) {
    case "restricted_api_key":
      return "La clé API Resend est limitée à l'envoi d'emails : elle ne peut pas lire ni configurer les domaines. Les envois fonctionnent ; pour « Configurer le domaine d'envoi » et le test complet, utilisez une clé « Full access ».";
    case "invalid_idempotent_request":
      return "Resend a refusé l'envoi : cette clé d'idempotence a déjà servi pour un autre contenu.";
    case "concurrent_idempotent_requests":
      return "Le même email est déjà en cours d'envoi chez Resend, réessayez dans un instant.";
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
      return `Quota d'envoi Resend atteint (${message}) : les emails repartiront après la réinitialisation du quota ou un changement d'offre.`;
    case "invalid_from_address":
      return `Adresse d'expéditeur refusée par Resend : ${message}. Vérifiez l'expéditeur (Paramètres > Intégrations > Resend).`;
  }
  switch (status) {
    case 401:
      return "Clé API Resend invalide (Paramètres > Intégrations).";
    case 403:
      if (/not verified|domain/i.test(message))
        return `Resend refuse l'expéditeur : ${message}. Configurez et vérifiez le domaine d'envoi (Paramètres > Intégrations > Resend).`;
      return `La clé API Resend n'a pas les droits nécessaires (${message}). Utilisez une clé avec l'accès complet.`;
    case 404:
      return `Ressource introuvable chez Resend : ${message}.`;
    case 409:
      return `Conflit chez Resend : ${message}.`;
    case 422:
      return `Resend a refusé la demande : ${message}.`;
    case 429:
      return "Quota Resend atteint ou trop de requêtes, réessayez dans une minute.";
    default:
      return `Erreur Resend (${status}) : ${message}.`;
  }
}

export class ResendClient {
  private readonly apiKey: string;

  constructor(
    apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
    private readonly retry: RetryOptions = {},
  ) {
    this.apiKey = cleanSecret(apiKey);
  }

  /** Performs a request and parses JSON. `expect` lists the accepted status codes. GETs are retried on 429/5xx. */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; expect?: number[]; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T }> {
    if (hasForbiddenHeaderChars(this.apiKey))
      throw new ResendError(invalidSecretMessage("La clé API Resend"), 0);
    let res: Response;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        RESEND_API + path,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        { timeoutMs: this.timeoutMs, secrets: [this.apiKey], ...this.retry },
      );
    } catch (err) {
      const reason =
        err instanceof NetworkError ? err.reason : networkErrorReason(err, [this.apiKey]);
      throw new ResendError(`Resend injoignable (${reason}).`, 0);
    }
    const data = await readBody(res);
    const accepted = opts.expect ?? [200, 201];
    if (!accepted.includes(res.status)) {
      const body = data && typeof data === "object" ? (data as ResendErrorBody) : null;
      throw new ResendError(
        sanitizeMessage(describeResendError(res.status, body, `${method} ${path}`), [this.apiKey]),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T };
  }
}
