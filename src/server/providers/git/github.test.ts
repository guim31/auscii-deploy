import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appJwt, InstallationTokenSource } from "./github-app";
import { describeGitHubError, GitHubClient, GitHubError } from "./github-client";
import { GitHubProvider } from "./github";

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
    let stagingSha = "";
    const { p, calls } = provider({
      "POST https://api.github.com/repos/auscii/dupont/git/refs": () => ({ status: 201, body: {} }),
      "GET https://api.github.com/repos/auscii/dupont/git/ref/heads/staging": () => ({
        status: 200,
        body: { object: { sha: stagingSha } },
      }),
    });
    const r1 = await release("v1", { "index.html": "<h1>v1</h1>", "style.css": "body{}" });
    const first = await p.pushRelease({
      repo: "auscii/dupont",
      releaseDir: r1,
      branch: "staging",
      message: "Release v1",
    });
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    stagingSha = first.commitSha;

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
    stagingSha = second.commitSha;
    expect((await origin.raw(["ls-tree", "--name-only", "staging"])).trim()).toBe("index.html");
    await p.promote({ repo: "auscii/dupont", tag: "prod-2" });
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(
      second.commitSha,
    );

    // Rollback moves production backwards.
    const back = await p.promote({
      repo: "auscii/dupont",
      tag: "prod-3-retour",
      commitSha: first.commitSha,
    });
    expect(back.commitSha).toBe(first.commitSha);
    expect((await origin.raw(["rev-parse", "refs/heads/production"])).trim()).toBe(first.commitSha);

    // The token never stays in the local git config.
    const local = simpleGit({ baseDir: path.join(work, "work", "auscii__dupont") });
    expect(await local.raw(["config", "--get", "remote.origin.url"])).not.toContain("ghs_test");
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
