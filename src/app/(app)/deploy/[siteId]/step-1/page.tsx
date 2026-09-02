import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/session";
import { placementForSite } from "@/server/sites";
import { getSettings } from "@/server/settings";
import { DomainStep, type PlacementView } from "@/components/wizard/domain-step";

export const dynamic = "force-dynamic";

export default async function Step1Page({ params }: { params: Promise<{ siteId: string }> }) {
  const user = await requireUser();
  const { siteId } = await params;
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    include: { domainRecord: true },
  });
  if (!site) notFound();
  if (site.status !== "draft" && site.status !== "error") redirect(`/deploy/${siteId}/step-2`);

  const placement = await placementForSite(siteId);
  const settings = await getSettings();
  const gandiConfigured =
    settings.demoMode ||
    Boolean(await prisma.integration.findUnique({ where: { provider: "gandi" } }));
  const view: PlacementView =
    placement.kind === "existing"
      ? {
          kind: "existing",
          serverName: placement.server.name,
          sitesCount: await prisma.site.count({
            where: { serverId: placement.server.id, status: { in: ["ready", "preview", "live"] } },
          }),
          status: placement.server.status,
        }
      : {
          kind: "new-server",
          offerId: placement.offerId,
          offerPrice: placement.offerPrice,
          reasons: placement.reasons,
        };

  return (
    <DomainStep
      siteId={site.id}
      isAdmin={user.role === "admin"}
      gandiConfigured={gandiConfigured}
      placement={view}
      initial={{
        clientName: site.clientName,
        fqdn: site.domainRecord?.fqdn ?? "",
        owned: site.domainRecord?.owned ?? false,
        formsEmail: site.formsEmail ?? "",
        price: site.domainRecord?.price ?? null,
        currency: site.domainRecord?.currency ?? null,
      }}
    />
  );
}
