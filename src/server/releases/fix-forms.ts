import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { ExtractedFile } from "./intake";
import { FORMS_ENDPOINT } from "./analyze";

export const HONEYPOT_FIELD = "_gotcha";

export type FixFormsResult = {
  /** Number of <form> elements rewritten. */
  fixed: number;
  /** HTML files that were modified. */
  files: string[];
};

/**
 * Rewrites every <form> of the extracted site that does not post to the
 * built-in endpoint: action, method="post" and a hidden honeypot field. Forms
 * already wired are left untouched, and so are files without any form.
 */
export async function fixForms(dir: string, files: ExtractedFile[]): Promise<FixFormsResult> {
  const result: FixFormsResult = { fixed: 0, files: [] };
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path)).slice(0, 200);
  for (const file of htmlFiles) {
    const abs = path.join(dir, file.path);
    const html = await readFile(abs, "utf8");
    if (!/<form[\s>]/i.test(html)) continue;
    const $ = cheerio.load(html);
    let changed = 0;
    $("form").each((_, el) => {
      const form = $(el);
      const action = form.attr("action")?.trim() ?? null;
      const method = (form.attr("method") ?? "get").toLowerCase();
      const hasHoneypot = form.find(`[name="${HONEYPOT_FIELD}"]`).length > 0;
      if (action === FORMS_ENDPOINT && method === "post" && hasHoneypot) return;
      form.attr("action", FORMS_ENDPOINT);
      form.attr("method", "post");
      form.removeAttr("target");
      if (!hasHoneypot)
        form.prepend(
          `<input type="text" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">`,
        );
      changed++;
    });
    if (changed === 0) continue;
    await writeFile(abs, $.html());
    result.fixed += changed;
    result.files.push(file.path);
  }
  return result;
}

/** Lists the files of an extracted release, in the shape analyzeSite expects. */
export async function listSiteFiles(dir: string): Promise<ExtractedFile[]> {
  const out: ExtractedFile[] = [];
  async function walk(rel: string) {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) {
        const { size } = await stat(path.join(dir, relPath));
        out.push({ path: relPath, size });
      }
    }
  }
  await walk("");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
