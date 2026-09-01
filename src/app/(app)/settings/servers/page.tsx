import { requireUser } from "@/server/session";
import { getSettings } from "@/server/settings";
import { prisma } from "@/server/db";
import { evaluateServer } from "@/server/capacity";
import { getProviders, type ServerMetrics } from "@/server/providers";
import { PageHeader } from "@/components/app/page-header";
import { ServersTable, type ServerRow } from "@/components/settings/servers-table";

export const dynamic = "force-dynamic";

export default async function ServersPage() {
  const user = await requireUser();
  const settings = await getSettings();
  const providers = await getProviders();
  const servers = await prisma.server.findMany({
    where: { isDemo: settings.demoMode },
    include: {
      _count: { select: { sites: { where: { status: { in: ["ready", "preview", "live"] } } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  let offers: { id: string; monthlyPrice: number; vcpus: number; ramGb: number; diskGb: number }[] =
    [];
  try {
    offers = await providers.cloud.listOffers(settings.defaultZone);
  } catch {
    offers = [];
  }
  const rows: ServerRow[] = servers.map((s) => {
    const metrics = (s.metrics as ServerMetrics | null) ?? null;
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      ip: s.ip,
      offer: s.offer,
      zone: s.zone,
      monthlyPrice: s.monthlyPrice,
      sitesCount: s._count.sites,
      metrics,
      verdict: evaluateServer(
        {
          id: s.id,
          name: s.name,
          status: s.status,
          vcpus: s.vcpus,
          metrics,
          sitesCount: s._count.sites,
        },
        settings.capacity,
      ),
      createdAt: s.createdAt.toISOString(),
    };
  });
  return (
    <>
      <PageHeader
        title="Serveurs"
        description="Les serveurs se remplissent l'un après l'autre. Un nouveau serveur est proposé quand les seuils de charge sont atteints."
      />
      <ServersTable
        servers={rows}
        offers={offers}
        defaultOffer={settings.defaultOffer}
        isAdmin={user.role === "admin"}
        thresholds={settings.capacity}
      />
    </>
  );
}
