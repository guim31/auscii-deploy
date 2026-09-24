import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { ExtractedFile, IntakeNotes, SkippedFile } from "./intake";

export const FORMS_ENDPOINT = "/__forms/contact";
export const HONEYPOT_FIELD = "_gotcha";

/**
 * contact: a form a visitor fills to reach the business (email, message or phone field);
 * search, dialog and other forms are never rewired.
 */
export type FormKind = "contact" | "search" | "dialog" | "other";

export type FormInfo = {
  page: string;
  action: string | null;
  method: string;
  fieldCount: number;
  /** true when the form already posts to the built-in endpoint */
  wired: boolean;
  /** Absent in analyses made before it existed: treat as "contact". */
  kind?: FormKind;
  /** Sent by the page's JavaScript (submit handler, EmailJS, Formspree…) rather than by the browser. */
  jsDriven?: boolean;
  /** Fields without a name attribute: the browser does not send them. */
  unnamedFields?: number;
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
  /** Files of the archive left out at extraction (hidden, secrets, scripts, outside the site folder). */
  skippedFiles?: SkippedFile[];
  /** Folder of the archive used as the site root, when not the archive root. */
  siteRoot?: string | null;
};

export type AnalyzeOptions = {
  /** What the extraction left aside, reported as warnings. */
  intake?: Partial<IntakeNotes>;
  /** Address receiving the forms of the site; undefined when unknown. */
  formsEmail?: string | null;
};

const LARGE_FILE = 5 * 1024 ** 2;
/** HTML files above this size are not parsed: a huge page must not stall the app. */
export const MAX_PARSE_BYTES = 5 * 1024 ** 2;
const MAX_SCRIPT_BYTES = 1024 ** 2;
const MAX_HTML_FILES = 200;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 500;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i;

const SUBMIT_HOOK =
  /addEventListener\(\s*["']submit["']|\.onsubmit\s*=|\.on\(\s*["']submit["']|\.submit\(\s*(?:function|\()/;
const SUBMIT_ACTION = /preventDefault\s*\(|\bfetch\s*\(|XMLHttpRequest|\$\.(?:ajax|post)\b|axios\./;
const FORM_SERVICE = /emailjs|formspree|web3forms|formsubmit\.co|getform\.io|staticforms/i;

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveLink(fromPage: string, href: string): string {
  const clean = safeDecode(href.split(/[?#]/)[0]).normalize("NFC");
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

type Cheerio = cheerio.CheerioAPI;
/** A form element as handed out by cheerio iterations. */
type FormNode = Parameters<Cheerio>[0];

/** Visible fields of a form, without buttons, hidden inputs and honeypots. */
export function visibleFields($: Cheerio, form: FormNode) {
  return $(form)
    .find("input, textarea, select")
    .filter((_, el) => {
      const f = $(el);
      const type = (f.attr("type") ?? "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
      const name = f.attr("name") ?? "";
      if (name.startsWith("_")) return false;
      const style = (f.attr("style") ?? "").replace(/\s+/g, "").toLowerCase();
      const concealed =
        f.attr("aria-hidden") === "true" ||
        style.includes("display:none") ||
        style.includes("left:-9999") ||
        f.attr("hidden") !== undefined;
      return !(concealed && f.attr("tabindex") === "-1");
    });
}

/** What a form is for; only contact forms are rewired to the built-in endpoint. */
export function formKind($: Cheerio, form: FormNode): FormKind {
  const f = $(form);
  if ((f.attr("method") ?? "").toLowerCase() === "dialog") return "dialog";
  if ((f.attr("role") ?? "").toLowerCase() === "search") return "search";
  const fields = visibleFields($, form);
  const method = (f.attr("method") ?? "get").toLowerCase();
  if (method === "get" && fields.length === 1) {
    const only = fields.first();
    const name = (only.attr("name") ?? "").toLowerCase();
    if (
      (only.attr("type") ?? "").toLowerCase() === "search" ||
      ["q", "s", "query", "search", "recherche"].includes(name)
    )
      return "search";
  }
  const reachable = fields.filter((_, el) => {
    const x = $(el);
    const isTextarea = x.is("textarea");
    const type = (x.attr("type") ?? "").toLowerCase();
    const name = `${x.attr("name") ?? ""} ${x.attr("id") ?? ""}`.toLowerCase();
    return (
      isTextarea ||
      type === "email" ||
      type === "tel" ||
      /mail|courriel|message|t[ée]l[ée]phone|phone/.test(name)
    );
  });
  return reachable.length > 0 ? "contact" : "other";
}

async function readCapped(file: string, max: number): Promise<string | null> {
  try {
    const buf = await readFile(/* turbopackIgnore: true */ file);
    return buf.length > max ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}

/** Static analysis of an extracted site. Pure file-system reads, no network. */
export async function analyzeSite(
  dir: string,
  files: ExtractedFile[],
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  const fileSet = new Set(files.map((f) => f.path.normalize("NFC")));
  const hasIndex = fileSet.has("index.html");
  const issues: Analysis["issues"] = [];
  const pages: PageInfo[] = [];
  const forms: FormInfo[] = [];
  const brokenLinks: Analysis["brokenLinks"] = [];
  const largeFiles = files.filter((f) => f.size > LARGE_FILE);
  const scriptCache = new Map<string, string | null>();

  if (!hasIndex)
    issues.push({
      level: "error",
      message: "Aucun index.html à la racine de l'archive ni dans un de ses dossiers.",
    });

  const tooLarge: ExtractedFile[] = [];
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path)).slice(0, MAX_HTML_FILES);
  for (const file of htmlFiles) {
    if (file.size > MAX_PARSE_BYTES) {
      tooLarge.push(file);
      continue;
    }
    const html = await readFile(/* turbopackIgnore: true */ path.join(dir, file.path), "utf8");
    const $ = cheerio.load(html);
    const title = truncate($("title").first().text().replace(/\s+/g, " ").trim(), MAX_TITLE);
    const description = truncate(
      $('meta[name="description"]').attr("content")?.replace(/\s+/g, " ").trim(),
      MAX_DESCRIPTION,
    );

    // Scripts of the page, inline and local, to spot forms sent by JavaScript.
    let scripts = "";
    for (const el of $("script").toArray()) {
      const src = $(el).attr("src")?.trim();
      if (!src) {
        scripts += `\n${$(el).text()}`;
        continue;
      }
      if (FORM_SERVICE.test(src)) scripts += `\n${src}`;
      if (EXTERNAL.test(src)) continue;
      const target = resolveLink(file.path, src);
      if (!fileSet.has(target)) continue;
      if (!scriptCache.has(target))
        scriptCache.set(
          target,
          await readCapped(path.join(/* turbopackIgnore: true */ dir, target), MAX_SCRIPT_BYTES),
        );
      scripts += `\n${scriptCache.get(target) ?? ""}`;
    }
    const pageHooksSubmit =
      FORM_SERVICE.test(scripts) || (SUBMIT_HOOK.test(scripts) && SUBMIT_ACTION.test(scripts));

    $("form").each((_, el) => {
      const form = $(el);
      const action = form.attr("action")?.trim() ?? null;
      const method = (form.attr("method") ?? "get").toLowerCase();
      const fields = visibleFields($, el);
      const unnamedFields = fields.filter((__, f) => !$(f).attr("name")?.trim()).length;
      forms.push({
        page: file.path,
        action,
        method,
        fieldCount: fields.length,
        wired: action === FORMS_ENDPOINT && method === "post",
        kind: formKind($, el),
        jsDriven: form.attr("onsubmit") !== undefined || pageHooksSubmit,
        unnamedFields,
      });
    });

    $("script, style, noscript, template").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    const imagesWithoutAlt = $("img").filter((_, el) => !$(el).attr("alt")?.trim()).length;
    pages.push({
      path: file.path,
      title,
      description,
      text: text.slice(0, 4000),
      imagesWithoutAlt,
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
  if (tooLarge.length)
    issues.push({
      level: "warn",
      message: `Page(s) trop lourde(s) pour être analysée(s) : ${tooLarge.map((f) => f.path).join(", ")}. Vérifiez-les dans l'aperçu.`,
    });
  if (files.filter((f) => /\.html?$/i.test(f.path)).length > MAX_HTML_FILES)
    issues.push({
      level: "info",
      message: `Seules les ${MAX_HTML_FILES} premières pages ont été analysées.`,
    });

  issues.push(...formIssues(forms));

  const analysis: Analysis = {
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
  return completeAnalysis(analysis, opts);
}

const NO_FORMS_EMAIL =
  "Le site a un formulaire de contact mais aucune adresse de réception n'est renseignée (étape 1) : les messages ne seront pas transmis.";

/**
 * Adds to an analysis what the files alone cannot tell: what the extraction
 * left aside, and a missing reception address for the forms. Idempotent.
 */
export function completeAnalysis(analysis: Analysis, opts: AnalyzeOptions): Analysis {
  let out = opts.intake ? withIntakeNotes(analysis, opts.intake) : analysis;
  const hasContactForm = out.forms.some((f) => (f.kind ?? "contact") === "contact");
  if (
    hasContactForm &&
    opts.formsEmail !== undefined &&
    !opts.formsEmail?.trim() &&
    !out.issues.some((i) => i.message === NO_FORMS_EMAIL)
  )
    out = { ...out, issues: [...out.issues, { level: "warn", message: NO_FORMS_EMAIL }] };
  return out;
}

function formIssues(forms: FormInfo[]): Analysis["issues"] {
  const issues: Analysis["issues"] = [];
  const contact = forms.filter((f) => (f.kind ?? "contact") === "contact");
  const unwired = contact.filter((f) => !f.wired);
  const toTest = contact.filter((f) => f.wired && (f.jsDriven || (f.unnamedFields ?? 0) > 0));
  if (unwired.length) {
    issues.push({
      level: "warn",
      message: `${unwired.length} formulaire(s) n'envoient pas vers ${FORMS_ENDPOINT} : les messages ne seront pas reçus. Utilisez « Corriger les formulaires ».`,
    });
  } else if (toTest.length) {
    issues.push({
      level: "warn",
      message: `${toTest.length} formulaire(s) envoyé(s) par du JavaScript ou avec des champs sans nom : à tester en préproduction en envoyant un message d'essai.`,
    });
  } else if (contact.length) {
    issues.push({ level: "info", message: `${contact.length} formulaire(s) de contact prêt(s).` });
  }
  const jsUnwired = unwired.filter((f) => f.jsDriven || (f.unnamedFields ?? 0) > 0);
  if (jsUnwired.length)
    issues.push({
      level: "warn",
      message: `${jsUnwired.length} formulaire(s) utilisent du JavaScript ou ont des champs sans nom : même corrigés, testez-les en préproduction.`,
    });
  return issues;
}

const SKIP_LABEL: Record<SkippedFile["reason"], string> = {
  hidden: "fichiers cachés",
  secret: "fichiers sensibles",
  work: "dossiers de travail",
  script: "scripts et exécutables",
  outside: "hors du dossier du site",
};

function sample(items: string[], max = 5): string {
  return items.slice(0, max).join(", ") + (items.length > max ? `… (+${items.length - max})` : "");
}

/**
 * Adds what the extraction left aside to an analysis, as warnings. Idempotent:
 * calling it again with the same notes adds nothing.
 */
export function withIntakeNotes(analysis: Analysis, notes: Partial<IntakeNotes>): Analysis {
  const skipped = notes.skipped ?? [];
  const extra: Analysis["issues"] = [];
  if (notes.strippedRoot)
    extra.push({
      level: "info",
      message: `Dossier du site retenu dans l'archive : ${notes.strippedRoot}/`,
    });
  if (notes.otherRoots?.length)
    extra.push({
      level: "warn",
      message: `Plusieurs dossiers contiennent un index.html (${sample(notes.otherRoots)}) : seul ${notes.strippedRoot ?? "la racine"} est publié.`,
    });
  const unpublished = skipped.filter((s) => s.reason !== "outside");
  if (unpublished.length) {
    const kinds = [...new Set(unpublished.map((s) => SKIP_LABEL[s.reason]))].join(", ");
    extra.push({
      level: "warn",
      message: `Fichiers écartés, ils ne seront pas publiés (${kinds}) : ${sample(unpublished.map((s) => s.path))}.`,
    });
  }
  const outside = skipped.filter((s) => s.reason === "outside");
  if (outside.length)
    extra.push({
      level: "info",
      message: `${outside.length} fichier(s) hors du dossier du site écarté(s) : ${sample(
        outside.map((s) => s.path),
        3,
      )}.`,
    });
  const known = new Set(analysis.issues.map((i) => i.message));
  return {
    ...analysis,
    issues: [...extra.filter((i) => !known.has(i.message)), ...analysis.issues],
    skippedFiles: skipped.length ? skipped.slice(0, 500) : analysis.skippedFiles,
    siteRoot: notes.strippedRoot ?? analysis.siteRoot ?? null,
  };
}

/** Same analysis without the page texts, for the browser (they are only used by the AI report). */
export function analysisForClient(analysis: Analysis): Analysis {
  return {
    ...analysis,
    pages: analysis.pages.map((p) => ({ ...p, text: "" })),
    skippedFiles: analysis.skippedFiles?.slice(0, 50),
  };
}
