import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSite, FORMS_ENDPOINT } from "./analyze";
import { fixForms, HONEYPOT_FIELD, listSiteFiles } from "./fix-forms";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "auscii-fix-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  await mkdir(path.dirname(path.join(work, rel)), { recursive: true });
  await writeFile(path.join(work, rel), content);
}

describe("fixForms", () => {
  it("rewires forms, adds the honeypot and leaves the rest of the page intact", async () => {
    await write(
      "index.html",
      `<!DOCTYPE html><html lang="fr"><head><title>Accueil</title></head><body>
<h1>Bonjour</h1>
<form action="https://formspree.io/x" method="GET" target="_blank" class="contact">
  <input name="email"><textarea name="message"></textarea><button>Envoyer</button>
</form>
<p>© 2026</p></body></html>`,
    );
    await write(
      "contact/index.html",
      `<form action="${FORMS_ENDPOINT}" method="post"><input name="${HONEYPOT_FIELD}"><input name="email"></form>`,
    );
    await write("style.css", "body{}");
    const files = await listSiteFiles(work);
    expect(files.map((f) => f.path)).toEqual(["contact/index.html", "index.html", "style.css"]);

    const result = await fixForms(work, files);
    expect(result).toEqual({ fixed: 1, files: ["index.html"] });

    const html = await readFile(path.join(work, "index.html"), "utf8");
    expect(html).toContain(`action="${FORMS_ENDPOINT}"`);
    expect(html).toContain('method="post"');
    expect(html).not.toContain("target=");
    expect(html).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(html).toContain('class="contact"');
    expect(html).toContain("<h1>Bonjour</h1>");
    expect(html).toContain("© 2026");
    expect(html).toContain('lang="fr"');

    const analysis = await analyzeSite(work, files);
    expect(analysis.forms.every((f) => f.wired)).toBe(true);
    expect(analysis.issues.some((i) => i.message.includes("prêt"))).toBe(true);

    // Second run: nothing left to fix.
    expect(await fixForms(work, files)).toEqual({ fixed: 0, files: [] });
  });

  it("adds the honeypot to a form that only lacks it", async () => {
    await write(
      "index.html",
      `<form action="${FORMS_ENDPOINT}" method="post"><input name="a"></form>`,
    );
    const result = await fixForms(work, await listSiteFiles(work));
    expect(result.fixed).toBe(1);
    const html = await readFile(path.join(work, "index.html"), "utf8");
    expect(html.match(new RegExp(HONEYPOT_FIELD, "g"))).toHaveLength(1);
  });
});
