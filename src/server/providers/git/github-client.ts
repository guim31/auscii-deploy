/** Minimal GitHub REST client. Tokens never appear in logs or messages. */

import {
  fetchWithRetry,
  hasForbiddenHeaderChars,
  NetworkError,
  networkErrorReason,
  readBody,
  sanitizeMessage,
  type FetchLike,
  type RetryOptions,
} from "../http-utils";

export const GITHUB_API = "https://api.github.com";

export type { FetchLike };

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
    case 429:
      return "Limite d'API GitHub atteinte, réessayez dans quelques minutes.";
    default:
      return `Erreur GitHub (${status}) : ${message}.`;
  }
}

export class GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
    private readonly retry: RetryOptions = {},
  ) {}

  /** Performs a request and parses JSON. GETs are retried on 429/5xx. */
  async request<T>(
    method: string,
    path: string,
    opts: { token: string; tokenType?: "Bearer"; body?: unknown; expect?: number[] },
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const token = opts.token.trim();
    if (hasForbiddenHeaderChars(token))
      throw new GitHubError("Jeton GitHub invalide (caractère interdit dans l'en-tête).", 0);
    let res: Response;
    try {
      res = await fetchWithRetry(
        this.fetchImpl,
        GITHUB_API + path,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "auscii-deploy",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        { timeoutMs: this.timeoutMs, secrets: [token], ...this.retry },
      );
    } catch (err) {
      const reason = err instanceof NetworkError ? err.reason : networkErrorReason(err, [token]);
      throw new GitHubError(`GitHub injoignable (${reason}).`, 0);
    }
    const data = await readBody(res);
    const accepted = opts.expect ?? [200, 201, 202, 204];
    if (!accepted.includes(res.status)) {
      const body = data && typeof data === "object" ? (data as ErrorBody) : null;
      throw new GitHubError(
        sanitizeMessage(describeGitHubError(res.status, body, `${method} ${path}`), [token]),
        res.status,
        data,
      );
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}
