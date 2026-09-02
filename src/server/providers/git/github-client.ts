/** Minimal GitHub REST client. Tokens never appear in logs or messages. */

export const GITHUB_API = "https://api.github.com";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

type ErrorBody = {
  message?: string;
  errors?: { resource?: string; field?: string; code?: string; message?: string }[];
};

export function describeGitHubError(
  status: number,
  body: ErrorBody | null,
  fallback: string,
): string {
  const message = body?.message ?? fallback;
  switch (status) {
    case 401:
      return "Authentification GitHub refusée : vérifiez l'App ID et la clé privée (Paramètres > Intégrations).";
    case 403:
      if (/rate limit/i.test(message))
        return "Limite d'API GitHub atteinte, réessayez dans quelques minutes.";
      return `Permissions GitHub insuffisantes (${message}). L'App doit avoir Contents et Administration en lecture/écriture sur l'organisation.`;
    case 404:
      return `Ressource GitHub introuvable : ${message}. L'App est-elle installée sur l'organisation ?`;
    case 422: {
      const detail = body?.errors
        ?.map((e) => e.message ?? `${e.resource ?? ""}.${e.field ?? ""} ${e.code ?? ""}`)
        .join(" ; ");
      return `GitHub a refusé la demande : ${detail || message}.`;
    }
    default:
      return `Erreur GitHub (${status}) : ${message}.`;
  }
}

export class GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  async request<T>(
    method: string,
    path: string,
    opts: { token: string; tokenType?: "Bearer"; body?: unknown; expect?: number[] },
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(GITHUB_API + path, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "auscii-deploy",
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
      throw new GitHubError(`GitHub injoignable (${reason}).`, 0);
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
      throw new GitHubError(
        describeGitHubError(res.status, body, `${method} ${path}`),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
