import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/session";
import { ProvisionView } from "@/components/wizard/provision-view";
import type { ConsoleLog, ConsoleState } from "@/components/wizard/deploy-console";
import type { StepState } from "@/server/jobs/pipeline";

export const dynamic = "force-dynamic";

export default async function Step2Page({ params }: { params: Promise<{ siteId: string }> }) {
  await requireUser();
  const { siteId } = await params;
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) notFound();
  const deployment = await prisma.deployment.findFirst({
    where: { siteId, kind: "provision" },
    orderBy: { createdAt: "desc" },
    include: { logs: { orderBy: { id: "asc" } } },
  });
  if (!deployment) redirect(`/deploy/${siteId}/step-1`);

  const state: ConsoleState = {
    status: deployment.status,
    steps: deployment.steps as StepState[],
    error: deployment.error,
  };
  const logs: ConsoleLog[] = deployment.logs.map((l) => ({
    id: l.id,
    ts: l.ts.toISOString(),
    level: l.level,
    step: l.step,
    message: l.message,
  }));
  return (
    <ProvisionView
      siteId={siteId}
      deploymentId={deployment.id}
      initialState={state}
      initialLogs={logs}
    />
  );
}
