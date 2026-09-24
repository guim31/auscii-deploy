/** Minimal client for the Scaleway API. The secret key never appears in logs or messages. */

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

export const SCALEWAY_API = "https://api.scaleway.com";

export type { FetchLike };

export class ScalewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScalewayError";
  }

  /** Scaleway error type (`quotas_exceeded`, `out_of_stock`, `not_found`…), when given. */
  get type(): string | undefined {
    const d = this.details;
    return d && typeof d === "object" && "type" in d
      ? String((d as { type: unknown }).type)
      : undefined;
  }
}

type ErrorBody = {
  message?: string;
  type?: string;
  resource?: string;
  resource_id?: string;
  current_state?: string;
  fields?: Record<string, string[]>;
  details?: {
    argument_name?: string;
    reason?: string;
    help_message?: string;
    resource?: string;
    quota?: number;
    current?: number;
  }[];
};

const PERMISSIONS_HINT =
  "Attribuez-lui InstancesFullAccess et BlockStorageFullAccess sur le projet (Paramètres > Intégrations).";

/**
 * Translates a Scaleway error. The error `type` is tested before the HTTP
 * status: quotas, for instance, arrive as 403 and are not a permission issue
 * (types from scaleway-sdk-go scw/errors.go).
 */
export function describeScalewayError(
  status: number,
  body: ErrorBody | null,
  fallback: string,
): string {
  const message = body?.message ?? fallback;
  switch (body?.type) {
    case "quotas_exceeded": {
      const quotas = body.details
        ?.filter((d) => d.resource)
        .map((d) => `${d.resource} ${d.current ?? "?"}/${d.quota ?? "?"}`)
        .join(", ");
      return `Quota Scaleway atteint${quotas ? ` (${quotas})` : ""} : ${message}. Demandez une augmentation dans la console Scaleway (Organisation > Quotas).`;
    }
    case "out_of_stock":
      return `Offre indisponible dans cette zone pour le moment (rupture de stock chez Scaleway) : ${message}.`;
    case "permissions_denied":
      return `La clé API Scaleway n'a pas les permissions nécessaires (${message}). ${PERMISSIONS_HINT}`;
    case "denied_authentication":
      return "Clé API Scaleway invalide ou expirée (Paramètres > Intégrations).";
    case "precondition_failed":
      return `Précondition refusée par Scaleway : ${message}.`;
    case "transient_state":
      return `Ressource Scaleway en cours de changement d'état${body.current_state ? ` (${body.current_state})` : ""}, réessayez dans une minute.`;
    case "locked":
      return `Ressource verrouillée par Scaleway : ${message}. Contactez le support Scaleway.`;
    case "resource_expired":
      return `Ressource Scaleway expirée : ${message}.`;
    case "not_found":
      return `Ressource introuvable chez Scaleway : ${message}.`;
    case "invalid_arguments": {
      const details = body.details
        ?.map((d) => [d.argument_name, d.help_message ?? d.reason].filter(Boolean).join(" : "))
        .filter(Boolean)
        .join(" ; ");
      if (details) return `Scaleway a refusé la demande : ${details}.`;
      break;
    }
  }
  switch (status) {
    case 401:
      return "Clé API Scaleway invalide (Paramètres > Intégrations).";
    case 403:
      return `La clé API Scaleway n'a pas les permissions nécessaires (${message}). ${PERMISSIONS_HINT}`;
    case 404:
      return `Ressource introuvable chez Scaleway : ${message}.`;
    case 409:
      return `Conflit chez Scaleway : ${message}.`;
    case 412:
      return `Précondition refusée par Scaleway : ${message}.`;
    case 429:
      return "Trop de requêtes vers Scaleway, réessayez dans une minute.";
    default:
      if (body?.fields) {
        const fields = Object.entries(body.fields)
          .map(([k, v]) => `${k} : ${v.join(", ")}`)
          .join(" ; ");
        return `Scaleway a refusé la demande : ${fields}.`;
      }
      return `Erreur Scaleway (${status}) : ${message}.`;
  }
}

export class ScalewayClient {
  private readonly secretKey: string;

  constructor(
    secretKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
    private readonly retry: RetryOptions = {},
  ) {
    this.secretKey = cleanSecret(secretKey);
  }

  /** Performs a request and parses JSON. GETs are retried on 429/5xx. */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; rawBody?: string; contentType?: string; expect?: number[] } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    if (hasForbiddenHeaderChars(this.secretKey))
      throw new ScalewayError(invalidSecretMessage("La clé API Scaleway"), 0);
    let res: Response;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        SCALEWAY_API + path,
        {
          method,
          headers: {
            "X-Auth-Token": this.secretKey,
            Accept: "application/json",
            ...(opts.rawBody !== undefined
              ? { "Content-Type": opts.contentType ?? "text/plain" }
              : opts.body !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
          },
          body:
            opts.rawBody !== undefined
              ? opts.rawBody
              : opts.body !== undefined
                ? JSON.stringify(opts.body)
                : undefined,
        },
        { timeoutMs: this.timeoutMs, secrets: [this.secretKey], ...this.retry },
      );
    } catch (err) {
      const reason =
        err instanceof NetworkError ? err.reason : networkErrorReason(err, [this.secretKey]);
      throw new ScalewayError(`Scaleway injoignable (${reason}).`, 0);
    }
    const data = await readBody(res);
    const accepted = opts.expect ?? [200, 201, 202, 204];
    if (!accepted.includes(res.status)) {
      const body = data && typeof data === "object" ? (data as ErrorBody) : null;
      throw new ScalewayError(
        sanitizeMessage(describeScalewayError(res.status, body, `${method} ${path}`), [
          this.secretKey,
        ]),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
