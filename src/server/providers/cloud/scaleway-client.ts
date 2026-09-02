/** Minimal client for the Scaleway API. The secret key never appears in logs or messages. */

export const SCALEWAY_API = "https://api.scaleway.com";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ScalewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScalewayError";
  }
}

type ErrorBody = {
  message?: string;
  type?: string;
  resource?: string;
  fields?: Record<string, string[]>;
};

export function describeScalewayError(
  status: number,
  body: ErrorBody | null,
  fallback: string,
): string {
  const message = body?.message ?? fallback;
  switch (status) {
    case 401:
      return "Clé API Scaleway invalide (Paramètres > Intégrations).";
    case 403:
      return `La clé API Scaleway n'a pas les permissions nécessaires (${message}). Attribuez-lui InstancesFullAccess sur le projet.`;
    case 404:
      return `Ressource introuvable chez Scaleway : ${message}.`;
    case 409:
      return `Conflit chez Scaleway : ${message}.`;
    case 412:
      return `Précondition refusée par Scaleway : ${message}.`;
    case 429:
      return "Trop de requêtes vers Scaleway, réessayez dans une minute.";
    default:
      if (body?.type === "quotas_exceeded")
        return `Quota Scaleway atteint : ${message}. Demandez une augmentation dans la console.`;
      if (body?.type === "out_of_stock")
        return `Offre indisponible dans cette zone pour le moment : ${message}.`;
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
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; rawBody?: string; contentType?: string; expect?: number[] } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(SCALEWAY_API + path, {
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
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? "délai dépassé"
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ScalewayError(`Scaleway injoignable (${reason}).`, 0);
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
    const accepted = opts.expect ?? [200, 201, 202, 204];
    if (!accepted.includes(res.status)) {
      const body = typeof data === "object" ? (data as ErrorBody) : null;
      throw new ScalewayError(
        describeScalewayError(res.status, body, `${method} ${path}`),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
