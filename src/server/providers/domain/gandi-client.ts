/**
 * Minimal client for the Gandi v5 REST API. The token never appears in logs
 * or error messages; errors are translated for the deployment console.
 */

export const GANDI_API = "https://api.gandi.net/v5";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

type GandiErrorBody = {
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
  constructor(
    private readonly token: string,
    private readonly organizationId: string | undefined,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  /** Performs a request and parses JSON. `expect` lists the accepted status codes. */
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
    const url = new URL(GANDI_API + path);
    if (opts.sharing && this.organizationId)
      url.searchParams.set("sharing_id", this.organizationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
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
      throw new GandiError(`Gandi injoignable (${reason}).`, 0);
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
      const body = typeof data === "object" ? (data as GandiErrorBody) : null;
      throw new GandiError(
        describeGandiError(res.status, body, `${method} ${path}`),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
