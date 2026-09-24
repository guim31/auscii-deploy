/**
 * Optional check of the generated blocks with a real Caddy binary, through the
 * same install script as the SSH agent. Enabled by CADDY_BIN (path of caddy).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCaddySiteScript, type CaddyPaths } from "../providers/agent/remote-scripts";
import { previewCaddyBlock, productionCaddyBlock } from "./caddy";

const caddy = process.env.CADDY_BIN;

function install(paths: CaddyPaths, name: string, content: string) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn("bash", ["-c", writeCaddySiteScript(paths, { name, sha256 })]);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    child.stdin.end(content);
  });
}

describe.skipIf(!caddy)("generated blocks with a real Caddy", () => {
  let root: string;
  let paths: CaddyPaths;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "auscii-caddy-"));
    const sitesDir = path.join(root, "sites");
    await mkdir(sitesDir);
    await writeFile(
      path.join(root, "Caddyfile"),
      `{\n\temail admin@auscii.site\n}\nimport ${sitesDir}/*.caddy\n`,
    );
    paths = {
      sitesDir,
      validateCommand: `${caddy} validate --config ${root}/Caddyfile --adapter caddyfile`,
      lockFile: path.join(sitesDir, ".auscii.lock"),
    };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts the production and preview blocks side by side", async () => {
    const hosts = ["dupont.fr", "www.dupont.fr"];
    const prod = productionCaddyBlock({
      siteSlug: "dupont",
      hosts,
      pilotHost: "deploy.auscii.site",
    });
    const preview = previewCaddyBlock({
      siteSlug: "dupont",
      hosts: ["dupont.preview.auscii.site"],
      pilotHost: "deploy.auscii.site",
      previewToken: "tok_0123456789abcdefXYZ",
    });
    expect(await install(paths, "dupont", prod)).toMatchObject({ code: 0 });
    expect(await install(paths, "dupont--preview", preview)).toMatchObject({ code: 0 });
  });

  it("keeps the working block when the new one is refused", async () => {
    const before = await readFile(path.join(paths.sitesDir, "dupont.caddy"), "utf8");
    const res = await install(paths, "dupont", "dupont.fr {\n\tnot_a_directive\n}\n");
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/not_a_directive/);
    expect(await readFile(path.join(paths.sitesDir, "dupont.caddy"), "utf8")).toBe(before);
    expect((await readdir(paths.sitesDir)).filter((f) => f.endsWith(".caddy"))).toHaveLength(2);
  });
});
