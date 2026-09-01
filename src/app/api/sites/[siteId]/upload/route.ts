import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";
import { ingestUpload } from "@/server/sites";
import { IntakeError, MAX_ZIP_BYTES } from "@/server/releases/intake";
import { uploadsDir } from "@/server/releases/paths";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ siteId: string }> }) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { siteId } = await ctx.params;
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return NextResponse.json({ error: "Site introuvable" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "Aucun fichier reçu" }, { status: 400 });
  if (!/\.zip$/i.test(file.name))
    return NextResponse.json({ error: "Le fichier doit être une archive .zip" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES)
    return NextResponse.json(
      { error: `Archive trop volumineuse (max ${MAX_ZIP_BYTES / 1024 ** 2} Mo)` },
      { status: 413 },
    );

  await mkdir(uploadsDir(), { recursive: true });
  const zipPath = path.join(uploadsDir(), `${siteId}-${Date.now()}.zip`);
  await writeFile(zipPath, Buffer.from(await file.arrayBuffer()));

  try {
    const { release, analysis } = await ingestUpload(siteId, zipPath, user.id);
    return NextResponse.json({ releaseId: release.id, version: release.version, analysis });
  } catch (err) {
    if (err instanceof IntakeError)
      return NextResponse.json({ error: err.message }, { status: 422 });
    console.error("[upload]", err);
    return NextResponse.json({ error: "Impossible de lire l'archive" }, { status: 500 });
  }
}
