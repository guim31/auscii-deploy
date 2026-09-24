import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";
import { buildPreviewUrl } from "@/server/releases/preview";

export const dynamic = "force-dynamic";

/**
 * Former in-app preview URL, kept for links that still point here: checks the
 * session, then redirects to the signed, cookie-less preview (/apercu/…).
 * Nothing of the release is served on the tool's origin anymore.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ releaseId: string; path?: string[] }> },
) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { releaseId, path: segments = [] } = await ctx.params;
  if (!/^[a-z0-9]{1,64}$/i.test(releaseId))
    return new NextResponse("Version introuvable", { status: 404 });
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true },
  });
  if (!release) return new NextResponse("Version introuvable", { status: 404 });
  const rest = segments.map(encodeURIComponent).join("/");
  // Relative when previews share the tool's origin: request.url may carry the
  // internal scheme and host of the container behind Caddy.
  return new Response(null, {
    status: 302,
    headers: { Location: buildPreviewUrl(release.id) + rest, "Cache-Control": "no-store" },
  });
}
