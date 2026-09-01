import type { GitBranch, GitProvider } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type GitHubCredentials = {
  appId: string;
  installationId: string;
  privateKey: string;
  org: string;
};

/** Real GitHub App implementation lands in phase 5. */
export class GitHubProvider implements GitProvider {
  readonly name = "github";
  constructor(private readonly creds: GitHubCredentials | null) {}

  private notReady(): never {
    if (!this.creds?.privateKey)
      throw new ProviderNotConfiguredError(
        "GitHub",
        "GitHub App non configurée (Paramètres > Intégrations).",
      );
    throw new ProviderNotConfiguredError(
      "GitHub",
      "L'intégration GitHub réelle arrive en phase 5. Activez le mode démo.",
    );
  }

  createRepo(_slug: string): Promise<{ fullName: string; url: string }> {
    return this.notReady();
  }
  pushRelease(_input: {
    repo: string;
    releaseDir: string;
    branch: GitBranch;
    message: string;
  }): Promise<{ commitSha: string }> {
    return this.notReady();
  }
  promote(_input: { repo: string; tag: string }): Promise<{ commitSha: string; tag: string }> {
    return this.notReady();
  }
}
