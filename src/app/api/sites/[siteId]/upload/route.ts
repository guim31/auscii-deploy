import { createWriteStream } from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";
import { env } from "@/server/env";
import { ingestUpload } from "@/server/sites";
import { inspectSiteZip, IntakeError, MAX_ZIP_BYTES } from "@/server/releases/intake";
import { analysisForClient, completeAnalysis } from "@/server/releases/analyze";
import { uploadsDir } from "@/server/releases/paths";
import { previewUrl } from "@/server/releases/preview-url";

export const dynamic = "force-dynamic";

const TOO_LARGE = `Archive trop volumineuse (maximum ${MAX_ZIP_BYTES / 1024 ** 2} Mo).`;
/** Extractions running at once in this process: the app also serves everybody else. */
const MAX_CONCURRENT = 2;

class TooLargeError extends Error {}

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The upload changes data with the ambient session: only accept it from the
 * tool's own pages. Browsers always send Origin on a POST, and Sec-Fetch-Site
 * when they support it.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === new URL(env().APP_URL).host || host === request.headers.get("host");
}

// A promise chain per site (versions are numbered per site) and a small
// process-wide limit on extractions.
const siteQueues = new Map<string, Promise<unknown>>();
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const previous = siteQueues.get(siteId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
      running++;
      try {
        return await fn();
      } finally {
        running--;
        waiting.shift()?.();
      }
    });
  siteQueues.set(siteId, run);
  try {
    return await run;
  } finally {
    if (siteQueues.get(siteId) === run) siteQueues.delete(siteId);
  }
}

/** Streams the request body to disk, stopping as soon as it exceeds the limit. */
async function saveBody(body: ReadableStream<Uint8Array>, target: string): Promise<void> {
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > MAX_ZIP_BYTES) cb(new TooLargeError());
      else cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
    limiter,
    createWriteStream(/* turbopackIgnore: true */ target),
  );
}

function isVersionClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Receives a site archive as the raw request body (Content-Type
 * application/zip), streamed to disk, then extracts and analyses it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  if (!sameOrigin(request)) return json({ error: "Requête refusée." }, 403);

  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) return json({ error: TOO_LARGE }, 413);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (
    !["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(type)
  )
    return json({ error: "Le fichier doit être une archive .zip." }, 415);
  if (!request.body) return json({ error: "Aucun fichier reçu." }, 400);

  const { siteId } = await ctx.params;
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, formsEmail: true },
  });
  if (!site) return json({ error: "Site introuvable." }, 404);

  await mkdir(/* turbopackIgnore: true */ uploadsDir(), { recursive: true });
  const base = path.join(
    uploadsDir(),
    `${siteId}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const zipPath = `${base}.zip`;
  try {
    try {
      await saveBody(request.body, zipPath);
    } catch (err) {
      if (err instanceof TooLargeError) return json({ error: TOO_LARGE }, 413);
      return json({ error: "Envoi interrompu, réessayez." }, 400);
    }

    return await withSlot(siteId, async () => {
      // Reads only the zip directory: a bad archive is refused before a version is created.
      const notes = await inspectSiteZip(zipPath);
      for (let attempt = 1; ; attempt++) {
        // ingestUpload deletes the file it is given: hand it a hard link.
        const attemptPath = `${base}-${attempt}.zip`;
        await link(/* turbopackIgnore: true */ zipPath, attemptPath);
        try {
          const { release, analysis } = await ingestUpload(siteId, attemptPath, user.id);
          const complete = completeAnalysis(analysis, {
            intake: notes,
            formsEmail: site.formsEmail,
          });
          if (complete !== analysis)
            await prisma.release.update({
              where: { id: release.id },
              data: { analysis: complete as object },
            });
          return json({
            releaseId: release.id,
            version: release.version,
            analysis: analysisForClient(complete),
            previewUrl: previewUrl(release.id),
          });
        } catch (err) {
          // Two uploads from another process took the same version number.
          if (isVersionClash(err) && attempt < 3) continue;
          throw err;
        } finally {
          await rm(/* turbopackIgnore: true */ attemptPath, { force: true });
        }
      }
    });
  } catch (err) {
    if (err instanceof IntakeError) return json({ error: err.message }, 422);
    console.error("[upload]", err instanceof Error ? err.message : err);
    return json({ error: "Impossible de traiter l'archive, réessayez." }, 500);
  } finally {
    await rm(/* turbopackIgnore: true */ zipPath, { force: true });
  }
}
