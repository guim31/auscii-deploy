import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/session";
import { UploadStep, type ReleaseView } from "@/components/wizard/upload-step";
import type { Analysis } from "@/server/releases/analyze";
import type { AiReport } from "@/server/providers/types";

export const dynamic = "force-dynamic";

export default async function Step3Page({ params }: { params: Promise<{ siteId: string }> }) {
  await requireUser();
  const { siteId } = await params;
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: { releases: { orderBy: { version: "desc" }, take: 10 } },
  });
  if (!site) notFound();
  const releases: ReleaseView[] = site.releases.map((r) => ({
    id: r.id,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    sizeBytes: r.sizeBytes,
    fileCount: r.fileCount,
    analysis: (r.analysis as Analysis | null) ?? null,
    aiReport: (r.aiReport as AiReport | null) ?? null,
  }));
  return <UploadStep siteId={siteId} releases={releases} hasInfra={Boolean(site.serverId)} />;
}
