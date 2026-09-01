import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/session";
import { getSettings, previewHostFor } from "@/server/settings";
import { LaunchStep, type DeploymentView } from "@/components/wizard/launch-step";
import type { StepState } from "@/server/jobs/pipeline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TriangleAlertIcon } from "lucide-react";

export const dynamic = "force-dynamic";

function toView(
  d: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    steps: unknown;
    error: string | null;
    logs: {
      id: number;
      ts: Date;
      level: "info" | "success" | "warn" | "error";
      step: string | null;
      message: string;
    }[];
  } | null,
): DeploymentView | null {
  if (!d) return null;
  return {
    id: d.id,
    state: { status: d.status, steps: d.steps as StepState[], error: d.error },
    logs: d.logs.map((l) => ({
      id: l.id,
      ts: l.ts.toISOString(),
      level: l.level,
      step: l.step,
      message: l.message,
    })),
  };
}

export default async function Step4Page({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ release?: string }>;
}) {
  await requireUser();
  const { siteId } = await params;
  const { release: releaseParam } = await searchParams;
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: { releases: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!site) notFound();
  const releaseId = releaseParam ?? site.stagingReleaseId ?? site.releases[0]?.id;
  if (!releaseId) redirect(`/deploy/${siteId}/step-3`);
  const release = await prisma.release.findFirst({ where: { id: releaseId, siteId } });
  if (!release) redirect(`/deploy/${siteId}/step-3`);
  if (!site.serverId || !site.domain) {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Infrastructure incomplète</AlertTitle>
        <AlertDescription>
          Terminez d'abord l'étape 2 (provisioning) avant de mettre le site en ligne.
        </AlertDescription>
      </Alert>
    );
  }
  const settings = await getSettings();
  const [staging, promote] = await Promise.all([
    prisma.deployment.findFirst({
      where: { siteId, releaseId, kind: "deploy" },
      orderBy: { createdAt: "desc" },
      include: { logs: { orderBy: { id: "asc" } } },
    }),
    prisma.deployment.findFirst({
      where: { siteId, releaseId, kind: { in: ["promote", "rollback"] } },
      orderBy: { createdAt: "desc" },
      include: { logs: { orderBy: { id: "asc" } } },
    }),
  ]);
  const previewHost = site.previewHost ?? previewHostFor(site.slug, settings);
  return (
    <LaunchStep
      siteId={siteId}
      releaseId={release.id}
      version={release.version}
      domain={site.domain}
      previewUrl={`https://${previewHost}`}
      previewSecretUrl={`https://${previewHost}/__preview/${site.previewToken}`}
      demo={site.isDemo}
      stagingDone={site.stagingReleaseId === release.id}
      liveDone={site.liveReleaseId === release.id}
      staging={toView(staging)}
      promote={toView(promote)}
    />
  );
}
