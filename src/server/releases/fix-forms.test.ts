import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSite, FORMS_ENDPOINT } from "./analyze";
import {
  canFixForms,
  fixForms,
  HONEYPOT_FIELD,
  listSiteFiles,
  pageUrlPath,
  REDIRECT_FIELD,
} from "./fix-forms";

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
    // contact/index.html only lacked the redirect after sending.
    expect(result).toEqual({ fixed: 2, files: ["contact/index.html", "index.html"], skipped: [] });

    const html = await readFile(path.join(work, "index.html"), "utf8");
    expect(html).toContain(`action="${FORMS_ENDPOINT}"`);
    expect(html).toContain('method="post"');
    expect(html).not.toContain("target=");
    expect(html).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(html).toContain('class="contact"');
    expect(html).toContain("<h1>Bonjour</h1>");
    expect(html).toContain("© 2026");
    expect(html).toContain('lang="fr"');
    expect(html).toContain(`name="${REDIRECT_FIELD}" value="/?envoye=1"`);
    expect(html).toMatch(
      /<div hidden="" aria-hidden="true"[^>]*><label>Ne pas remplir <input[^>]*tabindex="-1" autocomplete="off"/,
    );
    expect(await readFile(path.join(work, "contact/index.html"), "utf8")).toContain(
      'value="/contact/?envoye=1"',
    );

    const analysis = await analyzeSite(work, files);
    expect(analysis.forms.every((f) => f.wired)).toBe(true);
    expect(analysis.issues.some((i) => i.message.includes("prêt"))).toBe(true);

    // Second run: nothing left to fix.
    expect(await fixForms(work, files)).toEqual({ fixed: 0, files: [], skipped: [] });
  });

  it("adds the honeypot to a form that only lacks it", async () => {
    await write(
      "index.html",
      `<form action="${FORMS_ENDPOINT}" method="post"><input name="email"></form>`,
    );
    const result = await fixForms(work, await listSiteFiles(work));
    expect(result.fixed).toBe(1);
    const html = await readFile(path.join(work, "index.html"), "utf8");
    expect(html.match(new RegExp(HONEYPOT_FIELD, "g"))).toHaveLength(1);
  });

  it("leaves search, dialog and non-contact forms alone", async () => {
    const page = `<form role="search" action="/s"><input name="q"></form>
<form method="dialog"><button>OK</button></form>
<form action="/recherche"><input type="search" name="terme"></form>
<form action="/panier" method="post"><input name="quantite"></form>
<form action="https://formspree.io/x"><input name="telephone" type="tel"></form>`;
    await write("index.html", page);
    await write("merci.html", "<p>Merci</p>");
    const result = await fixForms(work, await listSiteFiles(work));
    expect(result.fixed).toBe(1);
    const html = await readFile(path.join(work, "index.html"), "utf8");
    expect(html).toContain('<form role="search" action="/s">');
    expect(html).toContain('<form method="dialog">');
    expect(html).toContain('<form action="/recherche">');
    expect(html).toContain('<form action="/panier" method="post">');
    expect(html).toContain(`value="/merci.html"`);
    expect(html.match(new RegExp(FORMS_ENDPOINT, "g"))).toHaveLength(1);
  });

  it("skips pages that are not UTF-8 instead of corrupting them", async () => {
    const latin1 = Buffer.from(
      '<html><head><meta charset="iso-8859-1"></head><body><p>Qualité</p><form action="x"><input name="email"></form></body></html>',
      "latin1",
    );
    await writeFile(path.join(work, "index.html"), latin1);
    const result = await fixForms(work, await listSiteFiles(work));
    expect(result.fixed).toBe(0);
    expect(result.skipped[0]).toMatchObject({ path: "index.html" });
    expect(result.skipped[0].reason).toContain("iso-8859-1");
    expect(await readFile(path.join(work, "index.html"))).toEqual(latin1);
  });

  it("refuses a release already pushed or deployed", () => {
    expect(canFixForms({ commitSha: null, deploymentCount: 0 }).ok).toBe(true);
    expect(canFixForms({ commitSha: "abc", deploymentCount: 0 }).ok).toBe(false);
    expect(canFixForms({ commitSha: null, deploymentCount: 1 }).ok).toBe(false);
    expect(canFixForms({ commitSha: null, deploymentCount: 0, inUse: true }).ok).toBe(false);
  });

  it("maps pages to their public path", () => {
    expect(pageUrlPath("index.html")).toBe("/");
    expect(pageUrlPath("contact/index.html")).toBe("/contact/");
    expect(pageUrlPath("contact.html")).toBe("/contact.html");
  });
});
