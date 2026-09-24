import { cp, mkdir, open, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { GitError, simpleGit, type SimpleGit } from "simple-git";
import type { GitBranch, GitProvider } from "../types";
import { ProviderNotConfiguredError } from "../types";
import { sanitizeMessage } from "../http-utils";
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
  /** Test hook: remote URL for a repo (defaults to GitHub over HTTPS). Never carries a token. */
  remoteUrl?: (repoFullName: string) => string;
  /** Test hook: local working directory for a repo. */
  workDir?: (repoFullName: string) => string;
  /** How long to wait for another job working on the same repo (default 10 minutes). */
  lockTimeoutMs?: number;
};

type RepoResponse = { full_name: string; html_url: string; default_branch?: string };
type InstallationResponse = {
  id: number;
  account?: { login?: string; type?: string } | null;
  target_type?: string;
  permissions?: Record<string, string>;
};

const COMMITTER = { name: "auscii-deploy", email: "deploy@auscii.invalid" };
const GITHUB_HOST = "https://github.com/";
const EXTRAHEADER_KEY = `http.${GITHUB_HOST}.extraheader`;
/** Tag names tried when the requested one already points elsewhere: tag, tag-2 … tag-9. */
const TAG_ATTEMPTS = 9;

/**
 * HTTP header git sends to GitHub with an installation token, as
 * actions/checkout does. Passed with `-c` on each command, so the token is
 * never written to .git/config, even if the process dies mid-push.
 */
export function gitAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

export function gitAuthConfig(token: string): string {
  return `${EXTRAHEADER_KEY}=${gitAuthHeader(token)}`;
}

// ---------- Per-repository lock ----------

const STALE_LOCK_MS = 30 * 60_000;
const inProcessLocks = new Map<string, Promise<void>>();

type LockInfo = { pid: number; host: string; at: number };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(file: string): Promise<boolean> {
  try {
    const info = JSON.parse(await readFile(file, "utf8")) as LockInfo;
    // Same container: a dead pid is a crash. Across containers (app and
    // worker share /data), only the age can tell.
    if (info.host === hostname() && !processAlive(info.pid)) return true;
    return Date.now() - info.at > STALE_LOCK_MS;
  } catch {
    const s = await stat(file).catch(() => null);
    return !s || Date.now() - s.mtimeMs > STALE_LOCK_MS;
  }
}

/** Exclusive lock file next to the working copy (O_EXCL), shared by every process using /data. */
async function acquireFileLock(file: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const handle = await open(file, "wx");
      const info: LockInfo = { pid: process.pid, host: hostname(), at: Date.now() };
      await handle.writeFile(JSON.stringify(info));
      await handle.close();
      return () => unlink(file).catch(() => undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (await lockIsStale(file)) {
      await unlink(file).catch(() => undefined);
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        "Une autre opération git est en cours sur ce dépôt depuis trop longtemps : réessayez dans quelques minutes.",
      );
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Serialises the operations on one working copy: an in-process queue (two
 * jobs of the worker) plus a lock file (another process on the same volume).
 */
export async function withRepoLock<T>(
  dir: string,
  fn: () => Promise<T>,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  const previous = inProcessLocks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => mine);
  inProcessLocks.set(dir, tail);
  await previous;
  try {
    const unlock = await acquireFileLock(`${dir}.lock`, timeoutMs);
    try {
      return await fn();
    } finally {
      await unlock();
    }
  } finally {
    release();
    if (inProcessLocks.get(dir) === tail) inProcessLocks.delete(dir);
  }
}

// ---------- Provider ----------

/** Real GitHub App implementation: one private repository per site, git operations through the git binary. */
export class GitHubProvider implements GitProvider {
  readonly name = "github";
  private readonly client: GitHubClient;
  private readonly tokens: InstallationTokenSource | null;
  private readonly creds: GitHubCredentials | null;

  constructor(
    creds: GitHubCredentials | null,
    private readonly options: GitHubProviderOptions = {},
  ) {
    this.creds = creds
      ? {
          appId: (creds.appId ?? "").trim(),
          installationId: (creds.installationId ?? "").trim(),
          privateKey: (creds.privateKey ?? "").trim(),
          org: (creds.org ?? "").trim(),
        }
      : null;
    this.client = new GitHubClient(options.fetchImpl);
    this.tokens =
      this.creds?.appId && this.creds.installationId && this.creds.privateKey
        ? new InstallationTokenSource(
            this.client,
            this.creds.appId,
            this.creds.installationId,
            this.creds.privateKey,
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

  private remoteUrl(repo: string): string {
    return this.options.remoteUrl ? this.options.remoteUrl(repo) : `${GITHUB_HOST}${repo}.git`;
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

  /**
   * Opens (or initialises) the local working copy. The remote URL never holds
   * a token: authentication goes through a per-command header. Tokens left by
   * older versions (remote URL, FETCH_HEAD, extraheader) are scrubbed.
   */
  private async open(repo: string, token: string): Promise<SimpleGit> {
    const dir = this.workDir(repo);
    await mkdir(dir, { recursive: true });
    const git = simpleGit({ baseDir: dir, config: [gitAuthConfig(token)] });
    if (!(await git.checkIsRepo())) await git.init();
    await git.addConfig("user.name", COMMITTER.name, false, "local");
    await git.addConfig("user.email", COMMITTER.email, false, "local");
    await git.raw(["config", "--local", "--unset-all", EXTRAHEADER_KEY]).catch(() => undefined);
    const remotes = await git.getRemotes(true);
    const url = this.remoteUrl(repo);
    if (remotes.some((r) => r.name === "origin")) await git.remote(["set-url", "origin", url]);
    else await git.addRemote("origin", url);
    const fetchHead = path.join(dir, ".git", "FETCH_HEAD");
    const content = await readFile(fetchHead, "utf8").catch(() => "");
    if (/x-access-token/i.test(content)) await rm(fetchHead, { force: true });
    return git;
  }

  /** Runs a git operation under the repo lock, with secret-free errors. */
  private async withRepo<T>(
    repo: string,
    token: string,
    fn: (git: SimpleGit, dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = this.workDir(repo);
    return withRepoLock(
      dir,
      async () => {
        try {
          const git = await this.open(repo, token);
          return await fn(git, dir);
        } catch (err) {
          if (err instanceof GitHubError || err instanceof ProviderNotConfiguredError) throw err;
          const message = sanitizeMessage(err instanceof Error ? err.message : String(err), [
            token,
          ]).trim();
          // git's own errors (stderr) get a prefix; our French messages pass through.
          throw new Error(err instanceof GitError ? `Opération git échouée : ${message}` : message);
        }
      },
      this.options.lockTimeoutMs,
    );
  }

  async pushRelease(input: {
    repo: string;
    releaseDir: string;
    branch: GitBranch;
    message: string;
  }): Promise<{ commitSha: string }> {
    const { tokens } = this.ready();
    const token = await tokens.token();
    return this.withRepo(input.repo, token, async (git, dir) => {
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
        // Nothing new, but the branch may not have been pushed yet (crash after commit).
        await git.push("origin", `${input.branch}:${input.branch}`);
        return { commitSha: (await git.revparse(["HEAD"])).trim() };
      }
      await git.commit(input.message, undefined, { "--allow-empty": null });
      await git.push("origin", `${input.branch}:${input.branch}`);
      return { commitSha: (await git.revparse(["HEAD"])).trim() };
    });
  }

  /**
   * Moves production to `commitSha` (or to the staging head) and tags exactly
   * the commit pushed. When the tag already exists on another commit, the
   * next free name (`tag-2`…) is used; the returned `tag` is the one created.
   */
  async promote(input: {
    repo: string;
    tag: string;
    commitSha?: string;
  }): Promise<{ commitSha: string; tag: string }> {
    const { tokens } = this.ready();
    const token = await tokens.token();
    const sha = await this.withRepo(input.repo, token, async (git) => {
      let target = input.commitSha;
      if (!target) {
        const staging = (await git.listRemote(["--heads", "origin", "staging"])).trim();
        target = staging.split(/\s+/)[0];
        if (!target)
          throw new Error("Aucune version en préproduction à publier (branche staging absente)");
      }
      await git.fetch("origin", target).catch(() => git.fetch("origin", "staging"));
      await git.push(["--force", "origin", `${target}:refs/heads/production`]);
      return target;
    });
    const tag = await this.createTag(input.repo, input.tag, sha, token);
    return { commitSha: sha, tag };
  }

  private async createTag(repo: string, tag: string, sha: string, token: string): Promise<string> {
    const [owner, name] = repo.split("/");
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git`;
    const taken: string[] = [];
    for (let i = 1; i <= TAG_ATTEMPTS; i++) {
      const candidate = i === 1 ? tag : `${tag}-${i}`;
      try {
        await this.client.request("POST", `${base}/refs`, {
          token,
          body: { ref: `refs/tags/${candidate}`, sha },
          expect: [201],
        });
        return candidate;
      } catch (err) {
        if (!(
          err instanceof GitHubError &&
          err.status === 422 &&
          /already exists/i.test(JSON.stringify(err.details ?? ""))
        ))
          throw err;
      }
      const { data } = await this.client.request<{ object?: { sha?: string } }>(
        "GET",
        `${base}/ref/tags/${encodeURIComponent(candidate)}`,
        { token },
      );
      // Same commit: an earlier attempt of this promotion already tagged it.
      if (data.object?.sha === sha) return candidate;
      taken.push(candidate);
    }
    throw new Error(
      `Impossible de poser le tag ${tag} sur ${sha.slice(0, 7)} : ${taken.join(", ")} désignent déjà d'autres versions.`,
    );
  }

  /**
   * Used by the settings "Tester" button: the App, its installation on the
   * configured organisation (an Organization account, since repositories are
   * created with POST /orgs/{org}/repos) and its permissions.
   */
  async whoAmI(): Promise<{ app: string; org: string; repos: number }> {
    const { creds, tokens } = this.ready();
    const jwt = tokens.jwt();
    const app = (
      await this.client.request<{ slug?: string; name?: string }>("GET", "/app", { token: jwt })
    ).data;
    const installation = (
      await this.client.request<InstallationResponse>(
        "GET",
        `/app/installations/${encodeURIComponent(creds.installationId)}`,
        { token: jwt },
      )
    ).data;
    const login = installation.account?.login ?? "";
    if (login.toLowerCase() !== creds.org.toLowerCase())
      throw new Error(
        `L'installation ${creds.installationId} de l'App appartient à « ${login || "?"} », pas à l'organisation « ${creds.org} » configurée : corrigez l'organisation ou l'Installation ID.`,
      );
    const accountType = installation.account?.type ?? installation.target_type;
    if (accountType !== "Organization")
      throw new Error(
        `« ${login} » est un compte GitHub personnel : installez l'App sur une organisation GitHub, la création des dépôts n'est possible que dans une organisation.`,
      );
    const permissions = installation.permissions ?? {};
    const missing = [
      ["contents", "Contents"],
      ["administration", "Administration"],
    ]
      .filter(([key]) => permissions[key] !== "write")
      .map(([, label]) => label);
    if (missing.length)
      throw new Error(
        `L'App n'a pas la permission ${missing.join(" et ")} en lecture/écriture sur ${login} : modifiez ses permissions puis acceptez-les dans l'installation.`,
      );
    const token = await tokens.token();
    const repos = (
      await this.client.request<{ total_count: number }>(
        "GET",
        "/installation/repositories?per_page=1",
        { token },
      )
    ).data;
    return { app: app.name ?? app.slug ?? "?", org: login, repos: repos.total_count ?? 0 };
  }
}
