import { requireUser } from "@/server/session";
import { getSettings } from "@/server/settings";
import { prisma } from "@/server/db";
import { evaluateServer } from "@/server/capacity";
import { getProviders, type ServerMetrics } from "@/server/providers";
import { PageHeader } from "@/components/app/page-header";
import { ServersTable, type ServerRow } from "@/components/settings/servers-table";
import { bootstrapScript } from "@/server/deploy/bootstrap";
import { HOSTED_SITE_STATUSES } from "@/server/jobs/steps/server";

export const dynamic = "force-dynamic";

/** Metrics as saved by the hourly check, or null when absent or incomplete (never NaN on screen). */
function validMetrics(value: unknown): ServerMetrics | null {
  const m = value as Partial<ServerMetrics> | null;
  if (!m) return null;
  const numbers = [m.load15, m.vcpus, m.ramUsedPct, m.diskUsedPct, m.diskFreeBytes];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)) || !m.collectedAt)
    return null;
  return m as ServerMetrics;
}

export default async function ServersPage() {
  const user = await requireUser();
  const settings = await getSettings();
  const providers = await getProviders();
  const servers = await prisma.server.findMany({
    where: { isDemo: settings.demoMode },
    include: {
      _count: { select: { sites: { where: { status: { in: [...HOSTED_SITE_STATUSES] } } } } },
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
    const metrics = validMetrics(s.metrics);
    const status = s.status === "ready" && s.unreachableSince ? "unreachable" : s.status;
    return {
      id: s.id,
      name: s.name,
      status,
      lastError: s.lastError,
      provider: s.provider,
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
          status,
          vcpus: s.vcpus,
          metrics,
          sitesCount: s._count.sites,
        },
        settings.capacity,
      ),
      createdAt: s.createdAt.toISOString(),
    };
  });
  const script = bootstrapScript({
    sshPublicKey: settings.sshPublicKey || "ssh-ed25519 CLE-PUBLIQUE-A-GENERER auscii-deploy",
    acmeEmail: settings.gandiContact.email || `admin@${settings.techDomain}`,
  });
  return (
    <>
      <PageHeader
        title="Serveurs"
        description="Les serveurs se remplissent l'un après l'autre. Un nouveau serveur est proposé quand les seuils de charge sont atteints."
      />
      <ServersTable
        servers={rows}
        bootstrap={script}
        sshReady={Boolean(settings.sshPublicKey)}
        demo={settings.demoMode}
        offers={offers}
        defaultOffer={settings.defaultOffer}
        isAdmin={user.role === "admin"}
        thresholds={settings.capacity}
      />
    </>
  );
}
