import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appJwt, InstallationTokenSource, normalizePem } from "./github-app";
import { describeGitHubError, GitHubClient, GitHubError } from "./github-client";
import { gitAuthConfig, gitAuthHeader, GitHubProvider, withRepoLock } from "./github";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
function fakeFetch(
  routes: Record<string, (call: Call, n: number) => { status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.startsWith(k));
    if (!key)
      return new Response(JSON.stringify({ message: `no route ${call.method} ${url}` }), {
        status: 500,
      });
    counts[key] = (counts[key] ?? 0) + 1;
    const r = routes[key](call, counts[key]);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return { impl, calls };
}

const TOKEN_ROUTE = {
  "POST https://api.github.com/app/installations/42/access_tokens": () => ({
    status: 201,
    body: { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() },
  }),
};
const CREDS = { appId: "1234", installationId: "42", privateKey: PEM, org: "auscii" };

describe("GitHub App auth", () => {
  it("signs a JWT the public key verifies", () => {
    const jwt = appJwt("1234", PEM, 1_700_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "1234",
    });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("caches the installation token", async () => {
    const { impl, calls } = fakeFetch(TOKEN_ROUTE);
    const source = new InstallationTokenSource(new GitHubClient(impl), "1234", "42", PEM);
    expect(await source.token()).toBe("ghs_test");
    expect(await source.token()).toBe("ghs_test");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization.startsWith("Bearer ey")).toBe(true);
  });

  it("translates errors", () => {
    expect(describeGitHubError(401, null, "x")).toMatch(/App ID/);
    expect(describeGitHubError(403, { message: "API rate limit exceeded" }, "x")).toMatch(/Limite/);
    expect(
      describeGitHubError(
        422,
        { errors: [{ message: "name already exists on this account" }] },
        "x",
      ),
    ).toMatch(/already exists/);
  });
});

describe("GitHubProvider", () => {
  let work: string;
  let bare: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "auscii-git-"));
    bare = path.join(work, "origin.git");
    await simpleGit().init(["--bare", bare]);
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  function provider(routes: Parameters<typeof fakeFetch>[0]) {
    const { impl, calls } = fakeFetch({ ...TOKEN_ROUTE, ...routes });
    const p = new GitHubProvider(CREDS, {
      fetchImpl: impl,
      remoteUrl: () => bare,
      workDir: (repo) => path.join(work, "work", repo.replace("/", "__")),
    });
    return { p, calls };
  }

  async function release(name: string, files: Record<string, string>) {
    const dir = path.join(work, "releases", name);
    await mkdir(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
    return dir;
  }

  it("creates a private repo and reuses an existing one", async () => {
    const { p, calls } = provider({
      "POST https://api.github.com/orgs/auscii/repos": (_c, n) =>
        n === 1
          ? {
              status: 201,
              body: { full_name: "auscii/dupont", html_url: "https://github.com/auscii/dupont" },
            }
          : {
              status: 422,
              body: {
                message: "Validation Failed",
                errors: [{ message: "name already exists on this account" }],
              },
            },
      "GET https://api.github.com/repos/auscii/dupont": () => ({
        status: 200,
        body: { full_name: "auscii/dupont", html_url: "https://github.com/auscii/dupont" },
      }),
    });
    expect(await p.createRepo("dupont")).toEqual({
      fullName: "auscii/dupont",
      url: "https://github.com/auscii/dupont",
    });
    expect(await p.createRepo("dupont")).toEqual({
      fullName: "auscii/dupont",
      url: "https://github.com/auscii/dupont",
    });
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/repos"))?.body).toMatchObject({
      name: "dupont",
      private: true,
    });
  });

  it("pushes releases on staging, promotes to production with a tag, and rolls back", async () => {
    const { p, calls } = provider({
      "POST https://api.github.com/repos/auscii/dupont/git/refs": () => ({ status: 201, body: {} }),
    });
    const r1 = await release("v1", { "index.html": "<h1>v1</h1>", "style.css": "body{}" });
    const first = await p.pushRelease({
      repo: "auscii/dupont",
      releaseDir: r1,
      branch: "staging",
      message: "Release v1",
    });
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const origin = simpleGit({ baseDir: bare });
    expect((await origin.raw(["rev-parse", "refs/heads/staging"])).trim()).toBe(first.commitSha);
    expect(
      (await origin.raw(["ls-tree", "--name-only", "staging"])).trim().split("\n").sort(),
    ).toEqual(["index.html", "style.css"]);

    // Unchanged content: no new commit.
    const again = await p.pushRelease({
      repo: "auscii/dupont",
      releaseDir: r1,
      branch: "staging",
      message: "Release v1 again",
    });
    expect(again.commitSha).toBe(first.commitSha);

    const promoted = await p.promote({ repo: "auscii/dupont", tag: "prod-1" });
    expect(promoted.commitSha).toBe(first.commitSha);
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(first.commitSha);
    expect(calls.find((c) => c.url.endsWith("/git/refs"))?.body).toEqual({
      ref: "refs/tags/prod-1",
      sha: first.commitSha,
    });

    const r2 = await release("v2", { "index.html": "<h1>v2</h1>" });
    const second = await p.pushRelease({
      repo: "auscii/dupont",
      releaseDir: r2,
      branch: "staging",
      message: "Release v2",
    });
    expect(second.commitSha).not.toBe(first.commitSha);
    expect((await origin.raw(["ls-tree", "--name-only", "staging"])).trim()).toBe("index.html");
    await p.promote({ repo: "auscii/dupont", tag: "prod-2" });
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(
      second.commitSha,
    );
    // The tag is put on the commit pushed to production, never on a re-read of staging.
    expect(calls.filter((c) => c.url.endsWith("/git/refs")).at(-1)?.body).toEqual({
      ref: "refs/tags/prod-2",
      sha: second.commitSha,
    });
    expect(calls.some((c) => c.url.includes("/git/ref/heads/staging"))).toBe(false);

    // Rollback moves production backwards.
    const back = await p.promote({
      repo: "auscii/dupont",
      tag: "prod-3-retour",
      commitSha: first.commitSha,
    });
    expect(back.commitSha).toBe(first.commitSha);
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(first.commitSha);

    // The token never reaches the local git config, in any form.
    const local = simpleGit({ baseDir: path.join(work, "work", "auscii__dupont") });
    expect(await local.raw(["config", "--get", "remote.origin.url"])).toBe(`${bare}\n`);
    const config = await readFile(
      path.join(work, "work", "auscii__dupont", ".git", "config"),
      "utf8",
    );
    expect(config).not.toContain("ghs_test");
    expect(config).not.toContain(Buffer.from("x-access-token:ghs_test").toString("base64"));
    expect(config).not.toMatch(/extraheader/i);
  });

  it("scrubs a token left in the working copy by an older version or a crash", async () => {
    const dir = path.join(work, "work", "auscii__legacy");
    await mkdir(dir, { recursive: true });
    const legacy = simpleGit({ baseDir: dir });
    await legacy.init();
    await legacy.addRemote("origin", "https://x-access-token:ghs_old@github.com/auscii/legacy.git");
    await legacy.addConfig("http.https://github.com/.extraheader", "AUTHORIZATION: basic b2xk");
    await writeFile(
      path.join(dir, ".git", "FETCH_HEAD"),
      "abc\t\tbranch 'staging' of https://x-access-token:ghs_old@github.com/auscii/legacy\n",
    );
    const { p } = provider({});
    await p.pushRelease({
      repo: "auscii/legacy",
      releaseDir: await release("legacy", { "index.html": "x" }),
      branch: "staging",
      message: "Release",
    });
    const config = await readFile(path.join(dir, ".git", "config"), "utf8");
    expect(config).not.toContain("ghs_old");
    expect(config).not.toMatch(/extraheader/i);
    const fetchHead = await readFile(path.join(dir, ".git", "FETCH_HEAD"), "utf8").catch(() => "");
    expect(fetchHead).not.toContain("ghs_old");
  });

  it("serialises concurrent operations on the same repository", async () => {
    const { p } = provider({});
    const [a, b] = await Promise.all([
      p.pushRelease({
        repo: "auscii/concurrent",
        releaseDir: await release("c1", { "index.html": "one" }),
        branch: "staging",
        message: "one",
      }),
      p.pushRelease({
        repo: "auscii/concurrent",
        releaseDir: await release("c2", { "index.html": "two", "b.html": "b" }),
        branch: "production",
        message: "two",
      }),
    ]);
    const origin = simpleGit({ baseDir: bare });
    expect((await origin.raw(["rev-parse", "refs/heads/staging"])).trim()).toBe(a.commitSha);
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(b.commitSha);
    expect((await origin.raw(["show", `${a.commitSha}:index.html`])).trim()).toBe("one");
    expect((await origin.raw(["ls-tree", "--name-only", b.commitSha])).trim().split("\n")).toEqual([
      "b.html",
      "index.html",
    ]);
  });

  it("uses the next tag name when the tag points elsewhere, and is idempotent on the same commit", async () => {
    const existing: Record<string, string> = { "prod-9": "0".repeat(40) };
    const { p } = provider({
      "POST https://api.github.com/repos/auscii/tags/git/refs": (c) => {
        const body = c.body as { ref: string; sha: string };
        const name = body.ref.replace("refs/tags/", "");
        if (existing[name])
          return {
            status: 422,
            body: { message: "Reference already exists", errors: [] },
          };
        existing[name] = body.sha;
        return { status: 201, body: {} };
      },
      "GET https://api.github.com/repos/auscii/tags/git/ref/tags/": (c) => ({
        status: 200,
        body: { object: { sha: existing[c.url.split("/").at(-1)!] } },
      }),
    });
    const pushed = await p.pushRelease({
      repo: "auscii/tags",
      releaseDir: await release("t1", { "index.html": "t" }),
      branch: "staging",
      message: "t",
    });
    const first = await p.promote({ repo: "auscii/tags", tag: "prod-9" });
    expect(first).toEqual({ commitSha: pushed.commitSha, tag: "prod-9-2" });
    const again = await p.promote({ repo: "auscii/tags", tag: "prod-9" });
    expect(again.tag).toBe("prod-9-2");
    expect(existing["prod-9"]).toBe("0".repeat(40));
  });

  it("fails loudly when every tag name is taken by other commits", async () => {
    const { p } = provider({
      "POST https://api.github.com/repos/auscii/full/git/refs": () => ({
        status: 422,
        body: { message: "Reference already exists" },
      }),
      "GET https://api.github.com/repos/auscii/full/git/ref/tags/": () => ({
        status: 200,
        body: { object: { sha: "f".repeat(40) } },
      }),
    });
    await p.pushRelease({
      repo: "auscii/full",
      releaseDir: await release("f1", { "index.html": "f" }),
      branch: "staging",
      message: "f",
    });
    await expect(p.promote({ repo: "auscii/full", tag: "prod-1" })).rejects.toThrow(
      /Impossible de poser le tag prod-1/,
    );
  });

  it("reports git failures without the token", async () => {
    const { impl } = fakeFetch(TOKEN_ROUTE);
    const p = new GitHubProvider(CREDS, {
      fetchImpl: impl,
      remoteUrl: () => path.join(work, "missing.git"),
      workDir: (repo) => path.join(work, "work", `broken-${repo.replace("/", "__")}`),
    });
    const err = await p
      .pushRelease({
        repo: "auscii/broken",
        releaseDir: await release("broken", { "index.html": "x" }),
        branch: "staging",
        message: "x",
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Opération git échouée/);
    expect((err as Error).message).not.toContain("ghs_test");
    expect((err as Error).message).not.toContain(
      Buffer.from("x-access-token:ghs_test").toString("base64"),
    );
  });

  it("refuses to work without credentials", async () => {
    const p = new GitHubProvider({ appId: "", installationId: "", privateKey: "", org: "" });
    await expect(p.createRepo("x")).rejects.toThrow(/non configurée/);
  });

  it("surfaces API errors", async () => {
    const { p } = provider({
      "POST https://api.github.com/orgs/auscii/repos": () => ({
        status: 403,
        body: { message: "Resource not accessible by integration" },
      }),
    });
    await expect(p.createRepo("x")).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("git authentication", () => {
  it("sends the token as a GitHub-scoped header, as actions/checkout does", () => {
    const header = gitAuthHeader("ghs_abc");
    expect(header).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_abc").toString("base64")}`,
    );
    expect(gitAuthConfig("ghs_abc")).toBe(`http.https://github.com/.extraheader=${header}`);
  });

  it("accepts a private key pasted on one line with literal \\n", () => {
    const oneLine = PEM.trim().replace(/\n/g, "\\n");
    expect(normalizePem(`  ${oneLine}  `)).toBe(PEM.trim());
    expect(() => appJwt("1", "not a key")).toThrow(/Clé privée GitHub illisible/);
  });
});

describe("withRepoLock", () => {
  it("runs operations on one directory one at a time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "auscii-lock-"));
    const events: string[] = [];
    const op = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`${name}:end`);
    };
    await Promise.all([withRepoLock(dir, op("a")), withRepoLock(dir, op("b"))]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    await expect(stat(`${dir}.lock`)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("waits for a lock held by another process, and takes over a dead one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "auscii-lock-"));
    await writeFile(
      `${dir}.lock`,
      JSON.stringify({ pid: 999_999_999, host: hostname(), at: Date.now() }),
    );
    expect(await withRepoLock(dir, async () => "ran", 1000)).toBe("ran");
    await writeFile(
      `${dir}.lock`,
      JSON.stringify({ pid: 1, host: "other-container", at: Date.now() }),
    );
    await expect(withRepoLock(dir, async () => "ran", 300)).rejects.toThrow(/autre opération git/);
    await rm(`${dir}.lock`, { force: true });
    await rm(dir, { recursive: true, force: true });
  });
});

describe("GitHubProvider.whoAmI", () => {
  function whoAmI(installation: unknown) {
    const { impl } = fakeFetch({
      ...TOKEN_ROUTE,
      "GET https://api.github.com/app/installations/42": () => ({
        status: 200,
        body: installation,
      }),
      "GET https://api.github.com/app": () => ({ status: 200, body: { name: "AUSCII Deploy" } }),
      "GET https://api.github.com/installation/repositories": () => ({
        status: 200,
        body: { total_count: 3 },
      }),
    });
    return new GitHubProvider(CREDS, { fetchImpl: impl }).whoAmI();
  }
  const GOOD = {
    id: 42,
    account: { login: "AUSCII", type: "Organization" },
    permissions: { contents: "write", administration: "write", metadata: "read" },
  };

  it("checks the installation belongs to the configured organisation", async () => {
    expect(await whoAmI(GOOD)).toEqual({ app: "AUSCII Deploy", org: "AUSCII", repos: 3 });
    await expect(
      whoAmI({ ...GOOD, account: { login: "someone-else", type: "Organization" } }),
    ).rejects.toThrow(/appartient à « someone-else », pas à l'organisation « auscii »/);
  });

  it("refuses a personal account and missing permissions", async () => {
    await expect(whoAmI({ ...GOOD, account: { login: "auscii", type: "User" } })).rejects.toThrow(
      /compte GitHub personnel/,
    );
    await expect(
      whoAmI({ ...GOOD, permissions: { contents: "read", administration: "write" } }),
    ).rejects.toThrow(/Contents/);
  });
});
