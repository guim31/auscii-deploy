/**
 * Runs the remote scripts of the SSH agent locally, with bash, on a scratch
 * tree shaped like a site server. Covers what matters in production: a live
 * release is never deleted, a broken Caddy block never stays in place.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasReleaseScript,
  pruneReleasesScript,
  RELEASE_COMPLETE_MARKER,
  reloadCaddyScript,
  removeCaddySiteScript,
  uploadReleaseScript,
  writeCaddySiteScript,
  type CaddyPaths,
} from "./remote-scripts";

type Run = { code: number; stdout: string; stderr: string };

function sh(script: string, stdin?: NodeJS.ReadableStream | string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    if (typeof stdin === "string") child.stdin.end(stdin);
    else if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

function archiveOf(dir: string): NodeJS.ReadableStream {
  return Readable.from(tar.create({ gzip: true, cwd: dir, portable: true }, ["."]));
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "auscii-remote-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("release scripts", () => {
  async function site() {
    const siteDir = path.join(root, "srv", "dupont");
    const releasesDir = path.join(siteDir, "releases");
    await mkdir(releasesDir, { recursive: true });
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "index.html"), "<h1>v2</h1>");
    return { siteDir, releasesDir, src };
  }

  it("extracts a new release atomically and marks it complete", async () => {
    const { releasesDir, src } = await site();
    const res = await sh(uploadReleaseScript({ releasesDir, name: "rel-2" }), archiveOf(src));
    expect(res).toMatchObject({ code: 0 });
    expect(res.stdout).toContain("RELEASE_UPLOADED");
    expect(await readFile(path.join(releasesDir, "rel-2", "index.html"), "utf8")).toBe(
      "<h1>v2</h1>",
    );
    expect(existsSync(path.join(releasesDir, "rel-2", RELEASE_COMPLETE_MARKER))).toBe(true);
    // No temporary folder left behind.
    expect(await readdir(releasesDir)).toEqual(["rel-2"]);
    expect((await sh(hasReleaseScript({ releasesDir, name: "rel-2" }))).code).toBe(0);
    expect((await sh(hasReleaseScript({ releasesDir, name: "rel-9" }))).code).toBe(1);
  });

  it("never touches a complete release, even when it is live", async () => {
    const { siteDir, releasesDir, src } = await site();
    const live = path.join(releasesDir, "rel-2");
    await mkdir(live);
    await writeFile(path.join(live, "index.html"), "<h1>live</h1>");
    await writeFile(path.join(live, RELEASE_COMPLETE_MARKER), "");
    await symlink("releases/rel-2", path.join(siteDir, "current"));
    const res = await sh(uploadReleaseScript({ releasesDir, name: "rel-2" }), archiveOf(src));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("RELEASE_PRESENT");
    expect(await readFile(path.join(live, "index.html"), "utf8")).toBe("<h1>live</h1>");
  });

  it("replaces an incomplete folder left by an interrupted upload", async () => {
    const { releasesDir, src } = await site();
    await mkdir(path.join(releasesDir, "rel-2"));
    await writeFile(path.join(releasesDir, "rel-2", "half.html"), "partial");
    const res = await sh(uploadReleaseScript({ releasesDir, name: "rel-2" }), archiveOf(src));
    expect(res.code).toBe(0);
    expect(existsSync(path.join(releasesDir, "rel-2", "half.html"))).toBe(false);
    expect(existsSync(path.join(releasesDir, "rel-2", "index.html"))).toBe(true);
    expect(await readdir(releasesDir)).toEqual(["rel-2"]);
  });

  it("cleans up and fails on a corrupt archive, leaving no release", async () => {
    const { releasesDir } = await site();
    const res = await sh(uploadReleaseScript({ releasesDir, name: "rel-3" }), "not a tarball");
    expect(res.code).not.toBe(0);
    expect(await readdir(releasesDir)).toEqual([]);
  });

  it("prunes old releases, never current nor the kept ones", async () => {
    const { siteDir, releasesDir } = await site();
    for (const r of ["rel-1", "rel-2", "rel-3", "rel-4", "other"]) {
      await mkdir(path.join(releasesDir, r));
    }
    const staleTmp = path.join(releasesDir, ".tmp-abc");
    const freshTmp = path.join(releasesDir, ".tmp-def");
    await mkdir(staleTmp);
    await mkdir(freshTmp);
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(staleTmp, old, old);
    await symlink("releases/rel-3", path.join(siteDir, "current"));
    const res = await sh(pruneReleasesScript({ siteDir, keep: ["rel-1"] }));
    expect(res.code).toBe(0);
    expect(res.stdout.trim().split("\n").sort()).toEqual(["rel-2", "rel-4"]);
    expect((await readdir(releasesDir)).sort()).toEqual([".tmp-def", "other", "rel-1", "rel-3"]);
    expect(await readlink(path.join(siteDir, "current"))).toBe("releases/rel-3");
  });

  it("refuses to prune when current is not a symlink", async () => {
    const { siteDir, releasesDir } = await site();
    await mkdir(path.join(releasesDir, "rel-1"));
    await mkdir(path.join(siteDir, "current"));
    const res = await sh(pruneReleasesScript({ siteDir, keep: [] }));
    expect(res.code).not.toBe(0);
    expect(existsSync(path.join(releasesDir, "rel-1"))).toBe(true);
  });

  it("does nothing for a site without releases", async () => {
    const res = await sh(pruneReleasesScript({ siteDir: path.join(root, "nope"), keep: [] }));
    expect(res).toMatchObject({ code: 0, stdout: "" });
  });
});

describe.skipIf(process.platform === "win32")("caddy scripts", () => {
  let paths: CaddyPaths;

  beforeEach(async () => {
    const sitesDir = path.join(root, "sites");
    await mkdir(sitesDir);
    // Stand-in for `caddy validate`: any block containing INVALID breaks the configuration.
    const validate = path.join(root, "validate.sh");
    await writeFile(
      validate,
      `#!/bin/sh\nif grep -l INVALID ${sitesDir}/*.caddy 2>/dev/null; then echo '{"level":"info","msg":"noise"}'; echo "Error: bloc invalide"; exit 1; fi\nexit 0\n`,
    );
    await chmod(validate, 0o755);
    paths = { sitesDir, validateCommand: validate, lockFile: path.join(sitesDir, ".auscii.lock") };
  });

  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const write = (name: string, content: string, hash = sha(content)) =>
    sh(writeCaddySiteScript(paths, { name, sha256: hash }), content);
  const files = async () => (await readdir(paths.sitesDir)).filter((f) => f !== ".auscii.lock");

  it("installs a valid block and keeps a backup of the previous one", async () => {
    expect((await write("dupont", "v1 {}\n")).code).toBe(0);
    expect(await files()).toEqual(["dupont.caddy"]);
    expect((await write("dupont", "v2 {}\n")).code).toBe(0);
    expect(await readFile(path.join(paths.sitesDir, "dupont.caddy"), "utf8")).toBe("v2 {}\n");
    expect(await readFile(path.join(paths.sitesDir, "dupont.caddy.bak"), "utf8")).toBe("v1 {}\n");
  });

  it("restores the previous working block when validation fails", async () => {
    await write("dupont", "v1 {}\n");
    const res = await write("dupont", "INVALID {\n");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("Error: bloc invalide");
    expect(res.stderr).not.toContain('"level":"info"');
    expect(await readFile(path.join(paths.sitesDir, "dupont.caddy"), "utf8")).toBe("v1 {}\n");
    expect(await files()).toEqual(["dupont.caddy"]);
  });

  it("removes a new block that does not validate", async () => {
    const res = await write("dupont", "INVALID {\n");
    expect(res.code).toBe(3);
    expect(await files()).toEqual([]);
  });

  it("refuses a truncated upload without touching the live block", async () => {
    await write("dupont", "v1 {}\n");
    const res = await write("dupont", "v2 {", sha("v2 {}\n"));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("incomplète");
    expect(await readFile(path.join(paths.sitesDir, "dupont.caddy"), "utf8")).toBe("v1 {}\n");
    expect(await files()).toEqual(["dupont.caddy"]);
  });

  it("removes a block and its leftovers", async () => {
    await write("dupont", "v1 {}\n");
    await write("dupont", "v2 {}\n");
    expect((await sh(removeCaddySiteScript(paths, { name: "dupont" }))).code).toBe(0);
    expect(await files()).toEqual([]);
  });

  it("serializes changes and reloads under the same lock", async () => {
    const results = await Promise.all(["a", "b", "c", "d"].map((n) => write(n, `${n} {}\n`)));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    const reload = await sh(reloadCaddyScript(paths, "echo reloaded"));
    expect(reload).toMatchObject({ code: 0, stdout: "reloaded\n" });
    const held = spawn("flock", [paths.lockFile, "sleep", "2"]);
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await sh(reloadCaddyScript(paths, "true"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    held.kill();
  });
});
