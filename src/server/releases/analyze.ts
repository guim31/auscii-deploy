import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { ExtractedFile } from "./intake";

export const FORMS_ENDPOINT = "/__forms/contact";

export type FormInfo = {
  page: string;
  action: string | null;
  method: string;
  fieldCount: number;
  /** true when the form already posts to the built-in endpoint */
  wired: boolean;
};

export type PageInfo = {
  path: string;
  title?: string;
  description?: string;
  text: string;
  imagesWithoutAlt: number;
};

export type Analysis = {
  ok: boolean;
  hasIndex: boolean;
  fileCount: number;
  sizeBytes: number;
  pages: PageInfo[];
  forms: FormInfo[];
  brokenLinks: { page: string; href: string }[];
  largeFiles: { path: string; size: number }[];
  issues: { level: "error" | "warn" | "info"; message: string }[];
};

const LARGE_FILE = 5 * 1024 ** 2;
const EXTERNAL = /^(?:[a-z]+:|\/\/|#|\?)/i;

function resolveLink(fromPage: string, href: string): string {
  const clean = href.split(/[?#]/)[0];
  if (!clean) return fromPage;
  const base = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(fromPage), clean);
  const norm = path.posix.normalize(base).replace(/^\.\//, "");
  return norm === "." ? "" : norm;
}

function resolvesToFile(target: string, files: Set<string>): boolean {
  if (target === "" || target === ".") return files.has("index.html");
  if (files.has(target)) return true;
  const t = target.replace(/\/$/, "");
  return files.has(`${t}/index.html`) || files.has(`${t}.html`);
}

/** Static analysis of an extracted site. Pure file-system reads, no network. */
export async function analyzeSite(dir: string, files: ExtractedFile[]): Promise<Analysis> {
  const fileSet = new Set(files.map((f) => f.path));
  const hasIndex = fileSet.has("index.html");
  const issues: Analysis["issues"] = [];
  const pages: PageInfo[] = [];
  const forms: FormInfo[] = [];
  const brokenLinks: Analysis["brokenLinks"] = [];
  const largeFiles = files.filter((f) => f.size > LARGE_FILE);

  if (!hasIndex)
    issues.push({ level: "error", message: "Aucun index.html à la racine de l'archive." });

  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path)).slice(0, 200);
  for (const file of htmlFiles) {
    const html = await readFile(path.join(dir, file.path), "utf8");
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim() || undefined;
    const description = $('meta[name="description"]').attr("content")?.trim() || undefined;
    $("script, style, noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    const imagesWithoutAlt = $("img").filter((_, el) => !$(el).attr("alt")?.trim()).length;
    pages.push({
      path: file.path,
      title,
      description,
      text: text.slice(0, 4000),
      imagesWithoutAlt,
    });

    $("form").each((_, el) => {
      const action = $(el).attr("action")?.trim() ?? null;
      const method = ($(el).attr("method") ?? "get").toLowerCase();
      const fieldCount = $(el)
        .find("input, textarea, select")
        .not('[type="hidden"], [type="submit"]').length;
      forms.push({
        page: file.path,
        action,
        method,
        fieldCount,
        wired: action === FORMS_ENDPOINT && method === "post",
      });
    });

    const seen = new Set<string>();
    $("a[href], link[href], script[src], img[src], source[src]").each((_, el) => {
      const raw = ($(el).attr("href") ?? $(el).attr("src") ?? "").trim();
      if (!raw || EXTERNAL.test(raw) || seen.has(raw)) return;
      seen.add(raw);
      const target = resolveLink(file.path, raw);
      if (!resolvesToFile(target, fileSet)) brokenLinks.push({ page: file.path, href: raw });
    });
  }

  const noTitle = pages.filter((p) => !p.title).length;
  if (noTitle) issues.push({ level: "warn", message: `${noTitle} page(s) sans balise <title>.` });
  const noDesc = pages.filter((p) => !p.description).length;
  if (pages.length && noDesc === pages.length)
    issues.push({ level: "info", message: "Aucune meta description trouvée." });
  const noAlt = pages.reduce((n, p) => n + p.imagesWithoutAlt, 0);
  if (noAlt) issues.push({ level: "warn", message: `${noAlt} image(s) sans attribut alt.` });
  if (brokenLinks.length)
    issues.push({ level: "warn", message: `${brokenLinks.length} lien(s) interne(s) cassé(s).` });
  if (largeFiles.length)
    issues.push({ level: "warn", message: `${largeFiles.length} fichier(s) de plus de 5 Mo.` });
  const unwired = forms.filter((f) => !f.wired);
  if (forms.length && unwired.length) {
    issues.push({
      level: "warn",
      message: `${unwired.length} formulaire(s) n'envoient pas vers ${FORMS_ENDPOINT} : les messages ne seront pas reçus. Corrigez l'attribut action et method="post".`,
    });
  } else if (forms.length) {
    issues.push({ level: "info", message: `${forms.length} formulaire(s) de contact prêt(s).` });
  }

  return {
    ok: hasIndex,
    hasIndex,
    fileCount: files.length,
    sizeBytes: files.reduce((n, f) => n + f.size, 0),
    pages,
    forms,
    brokenLinks,
    largeFiles,
    issues,
  };
}
