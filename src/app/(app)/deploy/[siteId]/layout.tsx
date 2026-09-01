import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { Stepper } from "@/components/wizard/stepper";
import { SiteStatusBadge } from "@/components/app/status-badge";

const REACHABLE: Record<string, number> = {
  draft: 1,
  provisioning: 2,
  error: 2,
  ready: 3,
  preview: 4,
  live: 4,
};

export default async function WizardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) notFound();
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{site.clientName}</h1>
        <SiteStatusBadge status={site.status} />
        {site.domain && <span className="text-muted-foreground text-sm">{site.domain}</span>}
      </div>
      <Stepper siteId={site.id} reachable={REACHABLE[site.status] ?? 1} />
      {children}
    </div>
  );
}
