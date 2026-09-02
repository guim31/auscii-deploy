import { createSign } from "node:crypto";
import { GitHubClient } from "./github-client";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Short-lived JWT identifying the GitHub App (RS256, 9 minutes). */
export function appJwt(
  appId: string,
  privateKeyPem: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

type TokenResponse = { token: string; expires_at: string };

/** Installation tokens live one hour; this cache renews them five minutes early. */
export class InstallationTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly client: GitHubClient,
    private readonly appId: string,
    private readonly installationId: string,
    private readonly privateKey: string,
  ) {}

  jwt(): string {
    return appJwt(this.appId, this.privateKey);
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 5 * 60_000) return this.cached.token;
    const { data } = await this.client.request<TokenResponse>(
      "POST",
      `/app/installations/${this.installationId}/access_tokens`,
      { token: this.jwt(), expect: [201] },
    );
    this.cached = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
    return data.token;
  }

  forget(): void {
    this.cached = null;
  }
}
