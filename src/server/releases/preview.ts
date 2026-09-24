import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "../env";
import { releaseDir } from "./paths";

/**
 * In-app preview of a release, served by the public route /apercu/<token>/…
 *
 * The preview runs the client's own HTML and JavaScript, so it never relies on
 * the operator's session: the URL carries a short-lived signed token instead of
 * a cookie, the CSP `sandbox` puts the page in an opaque origin, and in the
 * pilot the route is only answered on a dedicated host (PREVIEW_ORIGIN) that
 * shares nothing with the tool.
 */
export const PREVIEW_PREFIX = "/apercu";

/** Tokens live about a day; the expiry is rounded to the hour so the URL stays stable meanwhile. */
const TOKEN_TTL_MS = 24 * 3600_000;
const TOKEN_STEP_MS = 3600_000;
const RELEASE_ID = /^[a-z0-9]{1,64}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/** Files above this size are streamed as is, without root-relative URL rewriting. */
export const MAX_REWRITE_BYTES = 5 * 1024 ** 2;

let keyCache: { source: string; key: Buffer } | null = null;

function previewKey(): Buffer {
  const source = env().APP_ENCRYPTION_KEY;
  if (keyCache?.source !== source) {
    const key = Buffer.from(
      hkdfSync("sha256", Buffer.from(source, "hex"), Buffer.alloc(0), "auscii-preview", 32),
    );
    keyCache = { source, key };
  }
  return keyCache.key;
}

function mac(payload: string): Buffer {
  return createHmac("sha256", previewKey()).update(payload).digest();
}

/** Signed token `<releaseId>.<expiry in seconds, base36>.<HMAC-SHA256, base64url>`. */
export function signPreviewToken(releaseId: string, now = Date.now()): string {
  if (!RELEASE_ID.test(releaseId)) throw new Error(`Invalid release id: ${releaseId}`);
  const exp = (Math.ceil((now + TOKEN_TTL_MS) / TOKEN_STEP_MS) * TOKEN_STEP_MS) / 1000;
  const payload = `${releaseId}.${exp.toString(36)}`;
  return `${payload}.${mac(payload).toString("base64url")}`;
}

export type PreviewTokenCheck =
  { ok: true; releaseId: string; expiresAt: Date } | { ok: false; reason: "invalid" | "expired" };

/** Constant-time verification; the signature is checked before the expiry is trusted. */
export function verifyPreviewToken(token: string, now = Date.now()): PreviewTokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [releaseId, expB36, sig] = parts;
  if (!RELEASE_ID.test(releaseId) || !/^[0-9a-z]{1,9}$/.test(expB36) || !SIGNATURE.test(sig))
    return { ok: false, reason: "invalid" };
  const expected = mac(`${releaseId}.${expB36}`);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "invalid" };
  const exp = parseInt(expB36, 36) * 1000;
  if (!(exp > now)) return { ok: false, reason: "expired" };
  return { ok: true, releaseId, expiresAt: new Date(exp) };
}

/** Origin of the preview host when one is configured (PREVIEW_ORIGIN), else "" (same origin). */
export function previewOrigin(): string {
  const configured = env().PREVIEW_ORIGIN;
  return configured ? new URL(configured).origin : "";
}

/** Full preview URL of a release, root page. Server-side only (it signs). */
export function buildPreviewUrl(releaseId: string, now = Date.now()): string {
  return `${previewOrigin()}${PREVIEW_PREFIX}/${signPreviewToken(releaseId, now)}/`;
}

// ---------------------------------------------------------------------------
// Root-relative URL rewriting: "/style.css" must stay under /apercu/<token>/.
// ---------------------------------------------------------------------------

function isRootRelative(value: string, prefix: string): boolean {
  return (
    value.length > 0 &&
    value[0] === "/" &&
    value[1] !== "/" &&
    value[1] !== "\\" &&
    !value.startsWith(`${prefix}/`)
  );
}

function prefixed(value: string, prefix: string): string {
  const lead = value.length - value.trimStart().length;
  const trimmed = value.slice(lead);
  return isRootRelative(trimmed, prefix) ? `${value.slice(0, lead)}${prefix}${trimmed}` : value;
}

/** Inserts the prefix before the "/" that ends every match of `re` (the start of a root-relative URL). */
function insertPrefix(text: string, re: RegExp, prefix: string): string {
  return text.replace(re, (...args: unknown[]) => {
    const match = args[0] as string;
    const offset = args[args.length - 2] as number;
    const slashAt = offset + match.length - 1;
    if (text.startsWith(`${prefix}/`, slashAt)) return match;
    return `${match.slice(0, -1)}${prefix}/`;
  });
}

/** `url(/x)` and `@import "/x"` in a stylesheet or a style attribute. */
export function rewriteCss(css: string, prefix: string): string {
  const withUrls = insertPrefix(css, /url\(\s*["']?\/(?![/\\])/gi, prefix);
  return insertPrefix(withUrls, /@import\s+["']\/(?![/\\])/gi, prefix);
}

function rewriteSrcset(value: string, prefix: string): string {
  return insertPrefix(value, /(?:^|,)\s*\/(?![/\\])/g, prefix);
}

function rewriteRefresh(value: string, prefix: string): string {
  return insertPrefix(value, /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?["']?\/(?![/\\])/i, prefix);
}

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "data",
  "xlink:href",
  "background",
  "manifest",
]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

type Attr = { name: string; valueStart: number; valueEnd: number };

/**
 * Rewrites root-relative URLs of an HTML document so they stay inside the
 * preview prefix: URL attributes, srcset, meta refresh, inline styles and
 * <style> blocks. A single linear pass, no backtracking regex over the
 * document; script contents and comments are copied untouched.
 */
export function rewriteHtml(html: string, prefix: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end < 0 ? n : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    if (!isAlpha(html.charCodeAt(lt + 1))) {
      out += "<";
      i = lt + 1;
      continue;
    }
    // Tag name.
    let j = lt + 1;
    while (j < n) {
      const c = html.charCodeAt(j);
      if (isSpace(c) || c === 47 /* / */ || c === 62 /* > */) break;
      j++;
    }
    const tagName = html.slice(lt + 1, j).toLowerCase();
    // Attributes.
    const attrs: Attr[] = [];
    while (j < n) {
      let c = html.charCodeAt(j);
      if (isSpace(c) || c === 47) {
        j++;
        continue;
      }
      if (c === 62) break;
      const nameStart = j;
      while (j < n) {
        c = html.charCodeAt(j);
        if (isSpace(c) || c === 47 || c === 62 || c === 61 /* = */) break;
        j++;
      }
      const name = html.slice(nameStart, j).toLowerCase();
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      if (html.charCodeAt(j) !== 61) continue;
      j++;
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      const q = html.charCodeAt(j);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", j + 1);
        const end = close < 0 ? n : close;
        attrs.push({ name, valueStart: j + 1, valueEnd: end });
        j = close < 0 ? n : close + 1;
      } else {
        const start = j;
        while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
        attrs.push({ name, valueStart: start, valueEnd: j });
      }
    }
    const tagEnd = j < n ? j + 1 : n;
    const isRefresh =
      tagName === "meta" &&
      attrs.some(
        (a) =>
          a.name === "http-equiv" &&
          html.slice(a.valueStart, a.valueEnd).trim().toLowerCase() === "refresh",
      );
    let copyFrom = lt;
    for (const a of attrs) {
      const value = html.slice(a.valueStart, a.valueEnd);
      let next = value;
      if (URL_ATTRS.has(a.name)) next = prefixed(value, prefix);
      else if (SRCSET_ATTRS.has(a.name)) next = rewriteSrcset(value, prefix);
      else if (a.name === "style") next = rewriteCss(value, prefix);
      else if (a.name === "content" && isRefresh) next = rewriteRefresh(value, prefix);
      if (next !== value) {
        out += html.slice(copyFrom, a.valueStart) + next;
        copyFrom = a.valueEnd;
      }
    }
    out += html.slice(copyFrom, tagEnd);
    i = tagEnd;
    // Raw text elements: styles are rewritten, scripts are left alone.
    if (tagName === "style" || tagName === "script") {
      const closeRe = tagName === "style" ? /<\/style\s*>/gi : /<\/script\s*>/gi;
      closeRe.lastIndex = i;
      const m = closeRe.exec(html);
      const bodyEnd = m ? m.index : n;
      const body = html.slice(i, bodyEnd);
      out += tagName === "style" ? rewriteCss(body, prefix) : body;
      i = bodyEnd;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".vtt": "text/vtt; charset=utf-8",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function appOrigin(): string {
  return new URL(env().APP_URL).origin;
}

/**
 * The page runs in an opaque origin (sandbox without allow-same-origin), so it
 * can neither read the tool's cookies nor call its API with them, whatever the
 * host. External https resources (images, fonts, CDN scripts, map embeds) are
 * allowed: generated sites use them a lot, and blocking them would not stop a
 * hostile page anyway since a frame can always navigate itself elsewhere. XHR
 * and form posts stay on the preview origin.
 */
export function previewCsp(): string {
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
    "default-src 'self' 'unsafe-inline' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob: https:",
    "frame-src 'self' https:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors 'self' ${appOrigin()}`,
  ].join("; ");
}

function baseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": previewCsp(),
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    // Fonts and module scripts are fetched in CORS mode from the opaque origin.
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    // A release can be fixed in place (forms): always revalidate.
    "Cache-Control": "private, no-cache",
  };
}

function textResponse(status: number, message: string, extra: Record<string, string> = {}) {
  return new Response(message, {
    status,
    headers: { ...baseHeaders(), "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

/** When PREVIEW_ORIGIN is set, previews are only answered on that host. */
export function previewHostAllowed(request: Request): boolean {
  const configured = env().PREVIEW_ORIGIN;
  if (!configured) return true;
  const host = request.headers.get("host")?.toLowerCase();
  return host === new URL(configured).host.toLowerCase();
}

function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".") && segment !== ".well-known";
}

type Resolved = { file: string; size: number; mtimeMs: number; dirIndex: boolean };

async function statFile(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(/* turbopackIgnore: true */ file);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Maps URL segments to a file of the release, like the Caddy try_files of the sites. */
export async function resolvePreviewFile(
  root: string,
  segments: string[],
): Promise<Resolved | null> {
  const clean = segments.map((s) => s.normalize("NFC")).filter((s) => s.length > 0);
  if (clean.some((s) => s === ".." || s.includes("\0") || s.includes("\\") || isHiddenSegment(s)))
    return null;
  const rel = clean.length ? path.posix.normalize(clean.join("/")) : "";
  if (rel.startsWith("..") || rel.split("/").some(isHiddenSegment)) return null;
  const candidates: [string, boolean][] =
    rel === "" || rel === "."
      ? [["index.html", true]]
      : [
          [rel, false],
          [`${rel}/index.html`, true],
          [`${rel}.html`, false],
        ];
  for (const [candidate, dirIndex] of candidates) {
    const full = path.resolve(/* turbopackIgnore: true */ root, candidate);
    if (!full.startsWith(root + path.sep)) continue;
    const s = await statFile(full);
    if (s) return { file: full, dirIndex, ...s };
  }
  return null;
}

/** `<meta charset>` of the first KB, so a Latin-1 page keeps its encoding. */
export function htmlCharset(head: string): string {
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head.slice(0, 2048));
  const charset = m?.[1]?.toLowerCase();
  if (!charset || charset === "utf8") return "utf-8";
  return charset;
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

async function fileResponse(
  request: Request,
  resolved: Resolved,
  prefix: string,
  status = 200,
): Promise<Response> {
  const { file, size, mtimeMs } = resolved;
  const ext = path.extname(file).toLowerCase();
  const headers: Record<string, string> = {
    ...baseHeaders(),
    "Content-Type": contentTypeFor(file),
    ETag: `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`,
  };
  if (status === 200 && request.headers.get("if-none-match") === headers.ETag)
    return new Response(null, { status: 304, headers });

  const isHtml = ext === ".html" || ext === ".htm";
  const isCss = ext === ".css";
  if ((isHtml || isCss) && size <= MAX_REWRITE_BYTES) {
    // latin1 maps every byte to one char and back: whatever the real encoding,
    // only ASCII is inserted and every other byte comes out unchanged.
    const raw = (await readFile(/* turbopackIgnore: true */ file)).toString("latin1");
    const body = isHtml ? rewriteHtml(raw, prefix) : rewriteCss(raw, prefix);
    if (isHtml) headers["Content-Type"] = `text/html; charset=${htmlCharset(raw)}`;
    return new Response(request.method === "HEAD" ? null : Buffer.from(body, "latin1"), {
      status,
      headers,
    });
  }
  if (isHtml) headers["Content-Type"] = "text/html; charset=utf-8";

  headers["Accept-Ranges"] = "bytes";
  const rangeHeader = status === 200 ? request.headers.get("range") : null;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    const body =
      request.method === "HEAD"
        ? null
        : (Readable.toWeb(
            createReadStream(/* turbopackIgnore: true */ file, range),
          ) as ReadableStream);
    return new Response(body, { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  const body =
    request.method === "HEAD"
      ? null
      : (Readable.toWeb(createReadStream(/* turbopackIgnore: true */ file)) as ReadableStream);
  return new Response(body, { status, headers });
}

const FORM_NOTICE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Aperçu du formulaire</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937;line-height:1.5}a{color:#2563eb}</style></head>
<body><h1>Formulaire bien relié</h1><p>Dans l'aperçu, aucun message n'est envoyé. En préproduction et en production, les messages de ce formulaire seront transmis à l'adresse de réception du site.</p><p><a href="../">Revenir à l'accueil du site</a></p></body></html>`;

/** Entry point of the /apercu/<token>/… route, for GET, HEAD and POST. */
export async function servePreview(
  request: Request,
  token: string,
  segments: string[],
): Promise<Response> {
  if (!previewHostAllowed(request)) return new Response("Not found", { status: 404 });
  const check = verifyPreviewToken(token);
  if (!check.ok)
    return textResponse(
      check.reason === "expired" ? 410 : 404,
      check.reason === "expired"
        ? "Ce lien d'aperçu a expiré. Rouvrez l'aperçu depuis l'outil de déploiement."
        : "Aperçu introuvable.",
    );
  const prefix = `${PREVIEW_PREFIX}/${token}`;

  // Forms of the previewed site post here once rewired (/__forms/contact).
  if (segments[0] === "__forms") {
    if (request.method !== "POST") return textResponse(405, "Méthode non autorisée.");
    return new Response(FORM_NOTICE, {
      status: 200,
      headers: { ...baseHeaders(), "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "POST") return textResponse(405, "Méthode non autorisée.");

  const root = releaseDir(check.releaseId);
  const resolved = await resolvePreviewFile(root, segments);
  if (!resolved) {
    const notFound = await resolvePreviewFile(root, ["404.html"]);
    if (notFound) return fileResponse(request, notFound, prefix, 404);
    return textResponse(404, "Page introuvable dans cette version du site.");
  }
  if (resolved.dirIndex) {
    // "/blog" served as blog/index.html would resolve its relative links
    // against the parent folder. Next.js strips trailing slashes, so redirect
    // to the explicit file rather than to "blog/".
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/")) {
      const last = url.pathname.split("/").pop() ?? "";
      return new Response(null, {
        status: 302,
        headers: { ...baseHeaders(), Location: `${last}/index.html${url.search}` },
      });
    }
  }
  return fileResponse(request, resolved, prefix);
}
