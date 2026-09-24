import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { ExtractedFile } from "./intake";
import { FORMS_ENDPOINT, formKind, HONEYPOT_FIELD, MAX_PARSE_BYTES } from "./analyze";

export { HONEYPOT_FIELD };
export const REDIRECT_FIELD = "_redirect";

export type FixFormsResult = {
  /** Number of <form> elements rewritten. */
  fixed: number;
  /** HTML files that were modified. */
  files: string[];
  /** HTML files with forms that were left untouched, and why (in French, for the user). */
  skipped: { path: string; reason: string }[];
};

/** Thank-you pages a contact form can land on after sending, in order of preference. */
const THANK_YOU_PAGES = [
  "merci.html",
  "merci/index.html",
  "remerciement.html",
  "remerciements.html",
  "confirmation.html",
  "thank-you.html",
  "thanks.html",
];

/** Public URL path of a page: "a/index.html" → "/a/", "b.html" → "/b.html". */
export function pageUrlPath(rel: string): string {
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel}`;
}

/** Where a visitor lands after sending: the site's thank-you page, else the same page with ?envoye=1. */
export function redirectTarget(page: string, fileSet: Set<string>): string {
  const thanks = THANK_YOU_PAGES.find((p) => fileSet.has(p));
  return thanks ? pageUrlPath(thanks) : `${pageUrlPath(page)}?envoye=1`;
}

/** Declared charset of a page (meta charset or http-equiv), lower-cased, or null. */
export function declaredCharset(html: string): string | null {
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(html.slice(0, 4096));
  return m ? m[1].toLowerCase() : null;
}

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

const HONEYPOT_HTML = `<div hidden aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden"><label>Ne pas remplir <input type="text" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"></label></div>`;

/** A release already pushed to GitHub or deployed must not change under the same version. */
export function canFixForms(release: {
  commitSha: string | null;
  deploymentCount: number;
  /** Currently the staging or live release of its site. */
  inUse?: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (release.commitSha || release.deploymentCount > 0 || release.inUse)
    return {
      ok: false,
      error:
        "Cette version a déjà été envoyée en préproduction : déposez une nouvelle archive pour corriger les formulaires.",
    };
  return { ok: true };
}

/**
 * Rewires the contact forms of the extracted site to the built-in endpoint:
 * action, method="post", a honeypot field and a `_redirect` to a thank-you
 * page. Search, dialog and non-contact forms are left alone, and so are pages
 * whose encoding is not UTF-8 (rewriting them would corrupt the accents).
 */
export async function fixForms(dir: string, files: ExtractedFile[]): Promise<FixFormsResult> {
  const result: FixFormsResult = { fixed: 0, files: [], skipped: [] };
  const fileSet = new Set(files.map((f) => f.path));
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path)).slice(0, 200);
  for (const file of htmlFiles) {
    if (file.size > MAX_PARSE_BYTES) continue;
    const abs = path.join(/* turbopackIgnore: true */ dir, file.path);
    const buf = await readFile(/* turbopackIgnore: true */ abs);
    const raw = buf.toString("latin1");
    if (!/<form[\s>]/i.test(raw)) continue;
    const charset = declaredCharset(raw);
    if ((charset && charset !== "utf-8" && charset !== "utf8") || !isUtf8(buf)) {
      result.skipped.push({
        path: file.path,
        reason: `encodage ${charset ?? "non UTF-8"} : à corriger à la main ou à réenregistrer en UTF-8`,
      });
      continue;
    }
    const $ = cheerio.load(buf.toString("utf8"));
    let changed = 0;
    $("form").each((_, el) => {
      if (formKind($, el) !== "contact") return;
      const form = $(el);
      const action = form.attr("action")?.trim() ?? null;
      const method = (form.attr("method") ?? "get").toLowerCase();
      const hasHoneypot = form.find(`[name="${HONEYPOT_FIELD}"]`).length > 0;
      const hasRedirect = form.find(`[name="${REDIRECT_FIELD}"]`).length > 0;
      if (action === FORMS_ENDPOINT && method === "post" && hasHoneypot && hasRedirect) return;
      form.attr("action", FORMS_ENDPOINT);
      form.attr("method", "post");
      form.removeAttr("target");
      form.removeAttr("enctype");
      if (!hasHoneypot) form.prepend(HONEYPOT_HTML);
      if (!hasRedirect) {
        const input = $('<input type="hidden">');
        input.attr("name", REDIRECT_FIELD);
        input.attr("value", redirectTarget(file.path, fileSet));
        form.append(input);
      }
      changed++;
    });
    if (changed === 0) continue;
    await writeFile(/* turbopackIgnore: true */ abs, $.html(), "utf8");
    result.fixed += changed;
    result.files.push(file.path);
  }
  return result;
}

/** Lists the files of an extracted release, in the shape analyzeSite expects. */
export async function listSiteFiles(dir: string): Promise<ExtractedFile[]> {
  const out: ExtractedFile[] = [];
  async function walk(rel: string) {
    for (const entry of await readdir(/* turbopackIgnore: true */ path.join(dir, rel), {
      withFileTypes: true,
    })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) {
        const { size } = await stat(/* turbopackIgnore: true */ path.join(dir, relPath));
        out.push({ path: relPath, size });
      }
    }
  }
  await walk("");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
