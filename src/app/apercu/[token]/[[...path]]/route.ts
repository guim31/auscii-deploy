import { servePreview } from "@/server/releases/preview";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string; path?: string[] }> };

/**
 * Public, cookie-less preview of a release: /apercu/<signed token>/<file>.
 * In the pilot only the PREVIEW_ORIGIN host forwards /apercu/* here; the
 * token, the sandbox CSP and the host check live in servePreview.
 */
async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { token, path = [] } = await ctx.params;
  return servePreview(request, token, path);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
