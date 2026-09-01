import Link from "next/link";
import { PlusIcon, ArrowRightIcon } from "lucide-react";
import { requireUser } from "@/server/session";
import { getSettings } from "@/server/settings";
import { listDashboardSites } from "@/server/sites";
import { listCandidates } from "@/server/jobs/steps/server";
import { evaluateServer } from "@/server/capacity";
import { seedDemo } from "@/server/demo/seed";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { SiteCard, type SiteCardData } from "@/components/sites/site-card";
import { ServersBanner } from "@/components/sites/servers-banner";
import { SiteStatusBadge } from "@/components/app/status-badge";
import { relativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const RESUME_STEP: Record<string, string> = {
  draft: "step-1",
  provisioning: "step-2",
  error: "step-2",
  ready: "step-3",
  preview: "step-4",
};

export default async function DashboardPage() {
  await requireUser();
  const settings = await getSettings();
  if (settings.demoMode) await seedDemo();
  const [sites, candidates] = await Promise.all([
    listDashboardSites(settings.demoMode),
    listCandidates(settings.demoMode),
  ]);
  const live = sites.filter((s) => s.status === "live");
  const inProgress = sites.filter((s) => s.status !== "live");
  const servers = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    sitesCount: c.sitesCount,
    verdict: evaluateServer(c, settings.capacity),
  }));

  const cards: SiteCardData[] = live.map((s) => ({
    id: s.id,
    clientName: s.clientName,
    domain: s.domain,
    previewHost: s.previewHost,
    previewToken: s.previewToken,
    status: s.status,
    serverName: s.server?.name ?? null,
    screenshot: Boolean(s.screenshotPath),
    lastPublishedAt: s.lastPublishedAt?.toISOString() ?? null,
    ssl: s.sslChecks[0]
      ? {
          ok: s.sslChecks[0].ok,
          issuer: s.sslChecks[0].issuer,
          expiresAt: s.sslChecks[0].expiresAt?.toISOString() ?? null,
        }
      : null,
    liveReleaseId: s.liveReleaseId,
    stagingReleaseId: s.stagingReleaseId,
    demo: s.isDemo,
  }));

  return (
    <>
      <PageHeader
        title="Sites en production"
        description={
          live.length
            ? `${live.length} site${live.length > 1 ? "s" : ""} en ligne`
            : "Aucun site en ligne pour le moment"
        }
        actions={
          <Button asChild size="lg">
            <Link href="/deploy/new">
              <PlusIcon /> Déployer un nouveau site
            </Link>
          </Button>
        }
      />
      <ServersBanner servers={servers} />

      {inProgress.length > 0 && (
        <section className="mb-8">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">En cours</h2>
          <div className="bg-card divide-y rounded-lg border">
            {inProgress.map((s) => (
              <div key={s.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                <SiteStatusBadge status={s.status} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.clientName}</div>
                  <div className="text-muted-foreground truncate text-xs">
                    {s.domain ?? "domaine à définir"} · modifié {relativeTime(s.updatedAt)}
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/deploy/${s.id}/${RESUME_STEP[s.status] ?? "step-1"}`}>
                    Reprendre <ArrowRightIcon />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {cards.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((site) => (
            <SiteCard key={site.id} site={site} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <p className="text-muted-foreground">Votre premier site vous attend.</p>
          <Button asChild className="mt-4">
            <Link href="/deploy/new">
              <PlusIcon /> Déployer un nouveau site
            </Link>
          </Button>
        </div>
      )}
    </>
  );
}
