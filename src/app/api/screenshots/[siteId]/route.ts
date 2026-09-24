import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";
import { screenshotsDir } from "@/server/releases/paths";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { siteId } = await ctx.params;
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { screenshotPath: true },
  });
  if (!site?.screenshotPath) return new NextResponse(null, { status: 404 });
  const file = path.resolve(/* turbopackIgnore: true */ screenshotsDir(), site.screenshotPath);
  if (!file.startsWith(screenshotsDir() + path.sep)) return new NextResponse(null, { status: 404 });
  try {
    await stat(/* turbopackIgnore: true */ file);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const svg = file.endsWith(".svg");
  return new NextResponse(
    Readable.toWeb(createReadStream(/* turbopackIgnore: true */ file)) as ReadableStream,
    {
      headers: {
        "Content-Type": svg ? "image/svg+xml" : "image/png",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        // An SVG opened directly is a document: no script, no external load.
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    },
  );
}
