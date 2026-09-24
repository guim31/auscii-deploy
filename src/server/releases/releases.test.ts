import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseSiteRoot,
  extractSiteZip,
  inspectSiteZip,
  IntakeError,
  MAX_ENTRIES,
  safeRelative,
} from "./intake";
import { analysisForClient, analyzeSite, completeAnalysis, FORMS_ENDPOINT } from "./analyze";

let work: string;

type Entry = { name: string; content?: string; symlink?: boolean };

async function makeZip(entries: Entry[]): Promise<string> {
  const zipPath = path.join(work, `${Math.random().toString(36).slice(2)}.zip`);
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    const opts = e.symlink ? { mode: 0o120777 } : undefined;
    zip.addBuffer(Buffer.from(e.content ?? ""), e.name, opts);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(zipPath)).on("close", resolve).on("error", reject);
  });
  return zipPath;
}

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "auscii-test-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("extractSiteZip", () => {
  it("extracts files and reports sizes", async () => {
    const zipPath = await makeZip([
      { name: "index.html", content: "<html><title>A</title></html>" },
      { name: "css/style.css", content: "body{}" },
    ]);
    const res = await extractSiteZip(zipPath, path.join(work, "out"));
    expect(res.fileCount).toBe(2);
    expect(res.files.map((f) => f.path)).toEqual(["css/style.css", "index.html"]);
    expect(res.sizeBytes).toBe(29 + 6);
    expect(res.archiveHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.strippedRoot).toBeNull();
  });

  it("flattens a single wrapping directory and ignores macOS junk", async () => {
    const zipPath = await makeZip([
      { name: "monsite/index.html", content: "<html></html>" },
      { name: "monsite/img/a.png", content: "png" },
      { name: "__MACOSX/monsite/._index.html", content: "junk" },
      { name: "monsite/.DS_Store", content: "junk" },
    ]);
    const res = await extractSiteZip(zipPath, path.join(work, "out"));
    expect(res.strippedRoot).toBe("monsite");
    expect(res.files.map((f) => f.path)).toEqual(["img/a.png", "index.html"]);
  });

  it("refuses parent traversal and absolute paths", () => {
    expect(() => safeRelative("../evil.html")).toThrow(IntakeError);
    expect(() => safeRelative("a/../../evil.html")).toThrow(IntakeError);
    expect(() => safeRelative("/etc/passwd")).toThrow(IntakeError);
    expect(() => safeRelative("C:\\win.html")).toThrow(IntakeError);
    expect(safeRelative("a\\b.html")).toBe("a/b.html");
  });

  it("refuses symlinks", async () => {
    const zipPath = await makeZip([
      { name: "index.html", content: "x" },
      { name: "etc", content: "/etc/passwd", symlink: true },
    ]);
    await expect(extractSiteZip(zipPath, path.join(work, "out"))).rejects.toThrow(/symbolique/);
  });

  it("ignores tooling scripts beside the site instead of refusing the archive", async () => {
    const zipPath = await makeZip([
      { name: "index.html", content: "<html></html>" },
      { name: "deploy.sh", content: "#!/bin/sh" },
      { name: "tools/serve.py", content: "print()" },
    ]);
    const res = await extractSiteZip(zipPath, path.join(work, "out"));
    expect(res.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(res.skipped).toEqual([
      { path: "deploy.sh", reason: "script" },
      { path: "tools/serve.py", reason: "script" },
    ]);
  });

  it("refuses an archive with nothing publishable", async () => {
    const zipPath = await makeZip([{ name: "index.php", content: "<?php" }]);
    await expect(extractSiteZip(zipPath, path.join(work, "out"))).rejects.toThrow(
      /Aucun fichier publiable.*index\.php/,
    );
  });

  it("never extracts hidden files, secrets and agent instructions", async () => {
    const zipPath = await makeZip([
      { name: "site/index.html", content: "<html></html>" },
      { name: "site/.env", content: "SECRET=1" },
      { name: "site/.env.local", content: "SECRET=1" },
      { name: "site/.claude/settings.local.json", content: "{}" },
      { name: "site/CLAUDE.md", content: "# notes" },
      { name: "site/certs/server.pem", content: "-----BEGIN" },
      { name: "site/certs/server.key", content: "-----BEGIN" },
      { name: "site/node_modules/x/index.js", content: "" },
      { name: "site/.well-known/security.txt", content: "Contact: x" },
    ]);
    const out = path.join(work, "out");
    const res = await extractSiteZip(zipPath, out);
    expect(res.files.map((f) => f.path)).toEqual([".well-known/security.txt", "index.html"]);
    expect(res.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["site/.claude/settings.local.json", "hidden"],
      ["site/.env", "hidden"],
      ["site/.env.local", "hidden"],
      ["site/certs/server.key", "secret"],
      ["site/certs/server.pem", "secret"],
      ["site/CLAUDE.md", "secret"],
      ["site/node_modules/x/index.js", "work"],
    ]);
    await expect(readFile(path.join(out, ".env"))).rejects.toThrow();

    const a = await analyzeSite(out, res.files, { intake: res });
    const warning = a.issues.find((i) => i.message.startsWith("Fichiers écartés"));
    expect(warning?.message).toContain(".env");
    expect(warning?.message).toContain("fichiers sensibles");
    expect(a.skippedFiles).toHaveLength(7);
  });

  it("finds the build folder of a project and leaves its sources aside", async () => {
    const zipPath = await makeZip([
      { name: "proj/package.json", content: "{}" },
      { name: "proj/index.html", content: '<script type="module" src="/src/main.ts"></script>' },
      { name: "proj/src/main.ts", content: "" },
      { name: "proj/dist/index.html", content: "<html></html>" },
      { name: "proj/dist/assets/app.js", content: "" },
    ]);
    const res = await extractSiteZip(zipPath, path.join(work, "out"));
    expect(res.strippedRoot).toBe("proj/dist");
    expect(res.files.map((f) => f.path)).toEqual(["assets/app.js", "index.html"]);
    expect(res.skipped.filter((s) => s.reason === "outside").map((s) => s.path)).toEqual([
      "proj/index.html",
      "proj/package.json",
      "proj/src/main.ts",
    ]);
  });

  it("chooses the shallowest index.html", () => {
    expect(chooseSiteRoot(["index.html", "a/index.html"]).root).toBe("");
    expect(chooseSiteRoot(["x/site/index.html", "x/site/a/index.html", "x/notes.txt"])).toEqual({
      root: "x/site",
      others: [],
    });
    expect(chooseSiteRoot(["a/index.html", "b/index.html"])).toEqual({
      root: "a",
      others: ["b"],
    });
    expect(chooseSiteRoot(["public/index.html", "src/index.html"]).root).toBe("public");
    // A plain site with a "build" page is not a project build folder.
    expect(chooseSiteRoot(["index.html", "build/index.html"]).root).toBe("");
    expect(chooseSiteRoot(["wrap/a.html", "wrap/b.html"]).root).toBe("wrap");
  });

  it("accepts ./ prefixes, normalises names to NFC and counts duplicates once", async () => {
    const nfd = "e\u0301te\u0301.html"; // "été.html" as macOS writes it
    const zipPath = await makeZip([
      { name: "./index.html", content: "<a href='%C3%A9t%C3%A9.html'>x</a>" },
      { name: nfd, content: "<html></html>" },
      { name: "style.css", content: "a{}" },
      { name: "style.css", content: "b{}" },
    ]);
    const out = path.join(work, "out");
    const res = await extractSiteZip(zipPath, out);
    expect(res.files.map((f) => f.path)).toEqual(["été.html", "index.html", "style.css"]);
    expect(res.fileCount).toBe(3);
    const a = await analyzeSite(out, res.files);
    expect(a.brokenLinks).toEqual([]);
  });

  it("explains a file/folder name clash instead of failing", async () => {
    const zipPath = await makeZip([
      { name: "index.html", content: "x" },
      { name: "a", content: "x" },
      { name: "a/b.html", content: "x" },
    ]);
    await expect(extractSiteZip(zipPath, path.join(work, "out"))).rejects.toThrow(
      /Conflit de noms.*« a »/,
    );
  });

  it("refuses control characters in names", () => {
    expect(() => safeRelative("a\u0007.html")).toThrow(IntakeError);
    expect(safeRelative("./a/./b.html")).toBe("a/b.html");
  });

  it("turns a corrupt archive into a clean error", async () => {
    const bogus = path.join(work, "bogus.zip");
    await writeFile(bogus, "not a zip at all");
    await expect(extractSiteZip(bogus, path.join(work, "out"))).rejects.toBeInstanceOf(IntakeError);
  });

  it("checks the number of entries before reading them", async () => {
    const entries: Entry[] = [{ name: "index.html", content: "x" }];
    for (let i = 0; i < MAX_ENTRIES; i++) entries.push({ name: `__MACOSX/${i}`, content: "" });
    const zipPath = await makeZip(entries);
    await expect(inspectSiteZip(zipPath)).rejects.toThrow(/Trop de fichiers/);
  });

  it("inspects an archive without extracting it", async () => {
    const zipPath = await makeZip([
      { name: "w/index.html", content: "x" },
      { name: "w/.env", content: "x" },
    ]);
    expect(await inspectSiteZip(zipPath)).toEqual({
      strippedRoot: "w",
      otherRoots: [],
      skipped: [{ path: "w/.env", reason: "hidden" }],
    });
  });

  it("refuses an empty archive", async () => {
    const zipPath = await makeZip([{ name: "__MACOSX/x", content: "j" }]);
    await expect(extractSiteZip(zipPath, path.join(work, "out"))).rejects.toThrow(/vide/);
  });
});

describe("analyzeSite", () => {
  it("reports index, forms, broken links and alt attributes", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([
      {
        name: "index.html",
        content: `<html><head><title>Boulangerie Dupont</title></head><body>
          <a href="contact.html">Contact</a><a href="missing.html">Nope</a><a href="https://ext.example">ext</a>
          <img src="logo.png"><img src="hero.jpg" alt="Vitrine">
          <form action="mailto:x@y.z"><input name="email"></form>
          </body></html>`,
      },
      {
        name: "contact.html",
        content: `<html><body><form action="${FORMS_ENDPOINT}" method="post"><input name="nom"><textarea name="msg"></textarea></form></body></html>`,
      },
      { name: "logo.png", content: "png" },
    ]);
    const res = await extractSiteZip(zipPath, dir);
    const a = await analyzeSite(dir, res.files);
    expect(a.ok).toBe(true);
    expect(a.pages).toHaveLength(2);
    expect(a.pages.find((p) => p.path === "index.html")?.title).toBe("Boulangerie Dupont");
    expect(a.forms).toHaveLength(2);
    expect(a.forms.filter((f) => f.wired)).toHaveLength(1);
    expect(a.brokenLinks.map((b) => b.href)).toEqual(["missing.html", "hero.jpg"]);
    expect(a.issues.some((i) => i.message.includes("image(s) sans attribut alt"))).toBe(true);
    expect(a.issues.some((i) => i.message.includes("formulaire(s) n'envoient pas"))).toBe(true);
  });

  it("tells forms sent by JavaScript apart and ignores search forms and honeypots", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([
      {
        name: "index.html",
        content: `<html><head><title>${"T".repeat(500)}</title><script src="app.js"></script></head><body>
          <form role="search"><input name="q"></form>
          <form action="/recherche"><input type="search" name="terme"></form>
          <form method="dialog"><button>Fermer</button></form>
          <form id="contact" action="${FORMS_ENDPOINT}" method="post">
            <input type="text" name="_gotcha" tabindex="-1" aria-hidden="true">
            <input type="email" id="email"><textarea name="message"></textarea>
          </form></body></html>`,
      },
      {
        name: "app.js",
        content: `document.querySelector("#contact").addEventListener("submit", (e) => { e.preventDefault(); fetch("https://api.example") });`,
      },
    ]);
    const res = await extractSiteZip(zipPath, dir);
    const a = await analyzeSite(dir, res.files, { formsEmail: "" });
    expect(a.forms.map((f) => f.kind)).toEqual(["search", "search", "dialog", "contact"]);
    expect(a.forms[3]).toMatchObject({
      wired: true,
      jsDriven: true,
      unnamedFields: 1,
      fieldCount: 2,
    });
    expect(a.issues.some((i) => i.message.includes("à tester en préproduction"))).toBe(true);
    expect(a.issues.some((i) => i.message.includes("prêt"))).toBe(false);
    expect(a.issues.some((i) => i.message.includes("aucune adresse de réception"))).toBe(true);
    expect(a.pages[0].title?.length).toBeLessThanOrEqual(200);

    // Idempotent completion, and page texts stripped for the browser.
    const again = completeAnalysis(a, { formsEmail: null, intake: { skipped: [] } });
    expect(again.issues).toHaveLength(a.issues.length);
    expect(analysisForClient(a).pages[0].text).toBe("");
  });

  it("does not parse huge HTML files", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([
      { name: "index.html", content: "<html></html>" },
      { name: "big.html", content: `<html><body>${"x".repeat(6 * 1024 ** 2)}</body></html>` },
    ]);
    const res = await extractSiteZip(zipPath, dir);
    const a = await analyzeSite(dir, res.files);
    expect(a.pages.map((p) => p.path)).toEqual(["index.html"]);
    expect(
      a.issues.some((i) => i.message.includes("trop lourde") && i.message.includes("big.html")),
    ).toBe(true);
  });

  it("decodes links before checking them", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([
      { name: "index.html", content: `<a href="mon%20fichier.pdf">pdf</a><a href="tel:+33">t</a>` },
      { name: "mon fichier.pdf", content: "%PDF" },
    ]);
    const res = await extractSiteZip(zipPath, dir);
    expect((await analyzeSite(dir, res.files)).brokenLinks).toEqual([]);
  });

  it("flags a missing index", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([{ name: "about.html", content: "<html><body>x</body></html>" }]);
    const res = await extractSiteZip(zipPath, dir);
    const a = await analyzeSite(dir, res.files);
    expect(a.ok).toBe(false);
    expect(a.issues[0].level).toBe("error");
  });
});
