import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { GitBranch, GitProvider } from "../types";
import { ProviderNotConfiguredError } from "../types";
import { GitHubClient, GitHubError, type FetchLike } from "./github-client";
import { InstallationTokenSource } from "./github-app";
import { dataDir } from "../../releases/paths";

export type GitHubCredentials = {
  appId: string;
  installationId: string;
  privateKey: string;
  org: string;
};

export type GitHubProviderOptions = {
  fetchImpl?: FetchLike;
  /** Test hook: remote URL for a repo (defaults to GitHub over HTTPS with the installation token). */
  remoteUrl?: (repoFullName: string, token: string) => string;
  /** Test hook: local working directory for a repo. */
  workDir?: (repoFullName: string) => string;
};

type RepoResponse = { full_name: string; html_url: string; default_branch?: string };

const COMMITTER = { name: "auscii-deploy", email: "deploy@auscii.invalid" };

/** Real GitHub App implementation: one private repository per site, git operations through the git binary. */
export class GitHubProvider implements GitProvider {
  readonly name = "github";
  private readonly client: GitHubClient;
  private readonly tokens: InstallationTokenSource | null;

  constructor(
    private readonly creds: GitHubCredentials | null,
    private readonly options: GitHubProviderOptions = {},
  ) {
    this.client = new GitHubClient(options.fetchImpl);
    this.tokens =
      creds?.appId && creds.installationId && creds.privateKey
        ? new InstallationTokenSource(
            this.client,
            creds.appId,
            creds.installationId,
            creds.privateKey,
          )
        : null;
  }

  private ready(): { creds: GitHubCredentials; tokens: InstallationTokenSource } {
    if (!this.creds?.org || !this.tokens) {
      throw new ProviderNotConfiguredError(
        "GitHub",
        "GitHub App non configurée : organisation, App ID, Installation ID et clé privée sont requis (Paramètres > Intégrations).",
      );
    }
    return { creds: this.creds, tokens: this.tokens };
  }

  private remoteUrl(repo: string, token: string): string {
    return this.options.remoteUrl
      ? this.options.remoteUrl(repo, token)
      : `https://x-access-token:${token}@github.com/${repo}.git`;
  }

  private workDir(repo: string): string {
    return this.options.workDir
      ? this.options.workDir(repo)
      : path.join(dataDir(), "git", repo.replace("/", "__"));
  }

  async createRepo(slug: string): Promise<{ fullName: string; url: string }> {
    const { creds, tokens } = this.ready();
    const token = await tokens.token();
    try {
      const { data } = await this.client.request<RepoResponse>(
        "POST",
        `/orgs/${encodeURIComponent(creds.org)}/repos`,
        {
          token,
          body: {
            name: slug,
            private: true,
            description: `Site ${slug} déployé par auscii-deploy`,
            has_issues: false,
            has_wiki: false,
            has_projects: false,
            auto_init: false,
          },
          expect: [201],
        },
      );
      return { fullName: data.full_name, url: data.html_url };
    } catch (err) {
      if (
        err instanceof GitHubError &&
        err.status === 422 &&
        /already exists/i.test(JSON.stringify(err.details ?? ""))
      ) {
        const { data } = await this.client.request<RepoResponse>(
          "GET",
          `/repos/${encodeURIComponent(creds.org)}/${encodeURIComponent(slug)}`,
          { token },
        );
        return { fullName: data.full_name, url: data.html_url };
      }
      throw err;
    }
  }

  /** Opens (or initialises) the local working copy of a repository, with the remote pointing at GitHub. */
  private async open(repo: string, token: string): Promise<SimpleGit> {
    const dir = this.workDir(repo);
    await mkdir(dir, { recursive: true });
    const git = simpleGit({ baseDir: dir });
    if (!(await git.checkIsRepo())) await git.init();
    await git.addConfig("user.name", COMMITTER.name, false, "local");
    await git.addConfig("user.email", COMMITTER.email, false, "local");
    const remotes = await git.getRemotes(true);
    const url = this.remoteUrl(repo, token);
    if (remotes.some((r) => r.name === "origin")) await git.remote(["set-url", "origin", url]);
    else await git.addRemote("origin", url);
    return git;
  }

  /** Removes the remote URL (which carries the token) from the local config once done. */
  private async seal(git: SimpleGit): Promise<void> {
    await git.remote(["set-url", "origin", "https://github.com/"]).catch(() => undefined);
  }

  async pushRelease(input: {
    repo: string;
    releaseDir: string;
    branch: GitBranch;
    message: string;
  }): Promise<{ commitSha: string }> {
    const { tokens } = this.ready();
    const token = await tokens.token();
    const git = await this.open(input.repo, token);
    try {
      const dir = this.workDir(input.repo);
      const remoteHas =
        (await git.listRemote(["--heads", "origin", input.branch])).trim().length > 0;
      if (remoteHas) {
        await git.fetch("origin", input.branch);
        await git.checkout(["-B", input.branch, `origin/${input.branch}`]);
      } else {
        await git
          .checkout(["--orphan", input.branch])
          .catch(() => git.checkout(["-B", input.branch]));
        await git.raw(["rm", "-rf", "--cached", "."]).catch(() => undefined);
      }
      for (const entry of await readdir(dir)) {
        if (entry !== ".git") await rm(path.join(dir, entry), { recursive: true, force: true });
      }
      await cp(input.releaseDir, dir, {
        recursive: true,
        filter: (src) => path.basename(src) !== ".git",
      });
      await git.add(["-A"]);
      const status = await git.status();
      const hasHead = await git.revparse(["--verify", "HEAD"]).then(
        () => true,
        () => false,
      );
      if (hasHead && status.files.length === 0) {
        return { commitSha: (await git.revparse(["HEAD"])).trim() };
      }
      await git.commit(input.message, undefined, { "--allow-empty": null });
      await git.push("origin", `${input.branch}:${input.branch}`);
      return { commitSha: (await git.revparse(["HEAD"])).trim() };
    } finally {
      await this.seal(git);
    }
  }

  async promote(input: {
    repo: string;
    tag: string;
    commitSha?: string;
  }): Promise<{ commitSha: string; tag: string }> {
    const { creds, tokens } = this.ready();
    const token = await tokens.token();
    const git = await this.open(input.repo, token);
    try {
      let sha = input.commitSha;
      if (!sha) {
        const staging = (await git.listRemote(["--heads", "origin", "staging"])).trim();
        sha = staging.split(/\s+/)[0];
        if (!sha)
          throw new Error("Aucune version en préproduction à publier (branche staging absente)");
      }
      await git.fetch("origin", sha).catch(() => git.fetch("origin", "staging"));
      await git.push(["--force", "origin", `${sha}:refs/heads/production`]);
    } finally {
      await this.seal(git);
    }
    const [owner, name] = input.repo.split("/");
    const tagRef = `refs/tags/${input.tag}`;
    try {
      await this.client.request("POST", `/repos/${owner}/${name}/git/refs`, {
        token,
        body: { ref: tagRef, sha: input.commitSha ?? (await this.stagingHead(input.repo, token)) },
        expect: [201],
      });
    } catch (err) {
      if (!(
        err instanceof GitHubError &&
        err.status === 422 &&
        /already exists/i.test(JSON.stringify(err.details ?? ""))
      ))
        throw err;
    }
    return {
      commitSha: input.commitSha ?? (await this.stagingHead(input.repo, token)),
      tag: input.tag,
    };
  }

  private async stagingHead(repo: string, token: string): Promise<string> {
    const [owner, name] = repo.split("/");
    const { data } = await this.client.request<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${name}/git/ref/heads/staging`,
      { token },
    );
    return data.object.sha;
  }

  /** Used by the settings "Tester" button. */
  async whoAmI(): Promise<{ app: string; org: string; repos: number }> {
    const { creds, tokens } = this.ready();
    const app = (
      await this.client.request<{ slug?: string; name?: string }>("GET", "/app", {
        token: tokens.jwt(),
      })
    ).data;
    const token = await tokens.token();
    const repos = (
      await this.client.request<{
        total_count: number;
        repositories?: { owner?: { login?: string } }[];
      }>("GET", "/installation/repositories?per_page=1", { token })
    ).data;
    const org = repos.repositories?.[0]?.owner?.login ?? creds.org;
    return { app: app.name ?? app.slug ?? "?", org, repos: repos.total_count ?? 0 };
  }
}
