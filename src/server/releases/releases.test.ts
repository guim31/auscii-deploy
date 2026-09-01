import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSiteZip, IntakeError, safeRelative } from "./intake";
import { analyzeSite, FORMS_ENDPOINT } from "./analyze";

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

  it("refuses server-side scripts", async () => {
    const zipPath = await makeZip([{ name: "index.php", content: "<?php" }]);
    await expect(extractSiteZip(zipPath, path.join(work, "out"))).rejects.toThrow(/exécutable/);
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

  it("flags a missing index", async () => {
    const dir = path.join(work, "site");
    const zipPath = await makeZip([{ name: "about.html", content: "<html><body>x</body></html>" }]);
    const res = await extractSiteZip(zipPath, dir);
    const a = await analyzeSite(dir, res.files);
    expect(a.ok).toBe(false);
    expect(a.issues[0].level).toBe("error");
  });
});
