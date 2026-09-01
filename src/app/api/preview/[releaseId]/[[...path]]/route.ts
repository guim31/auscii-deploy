import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { apiUser, isResponse } from "@/server/api-auth";
import { releaseDir } from "@/server/releases/paths";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".map": "application/json",
};

const CSP =
  "default-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob: https:; font-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'";

async function resolveFile(root: string, segments: string[]): Promise<string | null> {
  const rel = path.posix.normalize(segments.join("/")).replace(/^(\.\.(\/|$))+/, "");
  const candidates =
    rel === "" || rel === "." ? ["index.html"] : [rel, `${rel}/index.html`, `${rel}.html`];
  for (const c of candidates) {
    const full = path.resolve(root, c);
    if (!full.startsWith(root + path.sep)) continue;
    try {
      const s = await stat(full);
      if (s.isFile()) return full;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Serves the extracted files of a release for the in-app preview iframe. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ releaseId: string; path?: string[] }> },
) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { releaseId, path: segments = [] } = await ctx.params;
  if (!/^[a-z0-9]+$/i.test(releaseId)) return new NextResponse("Not found", { status: 404 });
  const root = releaseDir(releaseId);
  const file = await resolveFile(root, segments);
  if (!file) {
    const notFound = await resolveFile(root, ["404.html"]);
    if (!notFound)
      return new NextResponse("Page introuvable dans cette version du site.", { status: 404 });
    return new NextResponse(
      Readable.toWeb(createReadStream(/* turbopackIgnore: true */ notFound)) as ReadableStream,
      { status: 404, headers: { "Content-Type": MIME[".html"], "Content-Security-Policy": CSP } },
    );
  }
  const ext = path.extname(file).toLowerCase();
  return new NextResponse(
    Readable.toWeb(createReadStream(/* turbopackIgnore: true */ file)) as ReadableStream,
    {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Security-Policy": CSP,
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "private, max-age=60",
      },
    },
  );
}
