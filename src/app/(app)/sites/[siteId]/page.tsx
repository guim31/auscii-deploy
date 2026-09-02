import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ExternalLinkIcon,
  LockIcon,
  MailIcon,
  ServerIcon,
  UploadIcon,
  ShieldCheckIcon,
  GitBranchIcon,
} from "lucide-react";
import { requireUser } from "@/server/session";
import { getSiteDetail } from "@/server/sites";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  SiteStatusBadge,
  DeployStatusBadge,
  DEPLOY_KIND_LABEL,
} from "@/components/app/status-badge";
import { RollbackButton } from "@/components/sites/site-actions";
import { DeployConsole, type ConsoleLog } from "@/components/wizard/deploy-console";
import { formatBytes } from "@/server/capacity";
import { formatDate, formatDateTime, daysUntil } from "@/lib/format";
import { prisma } from "@/server/db";
import type { StepState } from "@/server/jobs/pipeline";
import { getSettings } from "@/server/settings";
import { expectedDnsRecords } from "@/server/deploy/dns";
import { DnsRecordsCard } from "@/components/sites/dns-records-card";

export const dynamic = "force-dynamic";

export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ deployment?: string }>;
}) {
  await requireUser();
  const { siteId } = await params;
  const { deployment: focusId } = await searchParams;
  const site = await getSiteDetail(siteId);
  if (!site) notFound();
  const ssl = site.sslChecks[0];
  const settings = await getSettings();
  const dnsRecords =
    site.domainRecord && !site.domainRecord.dnsConfigured && site.server?.ip && !site.isDemo
      ? expectedDnsRecords(site.domainRecord.fqdn, site.slug, site.server.ip, settings)
      : null;
  const days = daysUntil(ssl?.expiresAt);
  const focus = focusId
    ? await prisma.deployment.findFirst({
        where: { id: focusId, siteId },
        include: { logs: { orderBy: { id: "asc" } } },
      })
    : null;
  const running =
    focus ??
    (await prisma.deployment.findFirst({
      where: { siteId, status: { in: ["queued", "running"] } },
      orderBy: { createdAt: "desc" },
      include: { logs: { orderBy: { id: "asc" } } },
    }));

  return (
    <>
      <PageHeader
        title={site.clientName}
        description={site.domain ?? undefined}
        actions={
          <>
            {site.status === "live" && !site.isDemo && site.domain && (
              <Button variant="outline" asChild>
                <a href={`https://${site.domain}`} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> Ouvrir le site
                </a>
              </Button>
            )}
            {site.previewHost && site.stagingReleaseId && !site.isDemo && (
              <Button variant="outline" asChild>
                <a
                  href={`https://${site.previewHost}/__preview/${site.previewToken}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <LockIcon /> Préproduction
                </a>
              </Button>
            )}
            <Button asChild>
              <Link href={`/deploy/${site.id}/step-3`}>
                <UploadIcon /> Mettre à jour
              </Link>
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription>État</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <SiteStatusBadge status={site.status} />
          </CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription className="flex items-center gap-1">
              <ServerIcon className="size-3.5" /> Serveur
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 text-sm">
            {site.server ? (
              <>
                <div className="font-medium">{site.server.name}</div>
                <div className="text-muted-foreground text-xs">
                  {site.server.ip ?? "—"} · {site.server.offer}
                </div>
              </>
            ) : (
              "—"
            )}
          </CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription className="flex items-center gap-1">
              <ShieldCheckIcon className="size-3.5" /> HTTPS
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 text-sm">
            {ssl?.ok ? (
              <>
                <div className="font-medium">{ssl.issuer ?? "Valide"}</div>
                <div
                  className={`text-xs ${days !== null && days < 14 ? "text-destructive" : "text-muted-foreground"}`}
                >
                  expire le {formatDate(ssl.expiresAt)}
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">
                {ssl ? (ssl.error ?? "Indisponible") : "Pas encore vérifié"}
              </span>
            )}
          </CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription className="flex items-center gap-1">
              <GitBranchIcon className="size-3.5" /> Dépôt
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 text-sm">
            {site.gitRepo ? (
              <>
                {site.isDemo ? (
                  <div className="font-medium">{site.gitRepo}</div>
                ) : (
                  <a
                    href={`https://github.com/${site.gitRepo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline"
                  >
                    {site.gitRepo}
                  </a>
                )}
                <div className="text-muted-foreground text-xs">
                  {site.releases.find((r) => r.id === site.liveReleaseId)?.gitTag ??
                    "staging → production"}
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">Versionnement local</span>
            )}
          </CardContent>
        </Card>
      </div>

      {dnsRecords && (
        <div className="mb-6">
          <DnsRecordsCard records={dnsRecords} />
        </div>
      )}

      {running && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {DEPLOY_KIND_LABEL[running.kind]} <DeployStatusBadge status={running.status} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DeployConsole
              deploymentId={running.id}
              compact
              initialState={{
                status: running.status,
                steps: running.steps as StepState[],
                error: running.error,
              }}
              initialLogs={running.logs.map((l): ConsoleLog => ({
                id: l.id,
                ts: l.ts.toISOString(),
                level: l.level,
                step: l.step,
                message: l.message,
              }))}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Versions</CardTitle>
              <CardDescription>
                Chaque dépôt de .zip crée une version. La version en ligne peut être remplacée par
                une précédente en un clic.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Reçue</TableHead>
                    <TableHead>Taille</TableHead>
                    <TableHead>État</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {site.releases.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        v{r.version}
                        {r.gitTag && (
                          <span className="text-muted-foreground ml-2 text-xs">{r.gitTag}</span>
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                      <TableCell>
                        {formatBytes(r.sizeBytes)} · {r.fileCount} fichiers
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {site.liveReleaseId === r.id && <Badge variant="success">En ligne</Badge>}
                          {site.stagingReleaseId === r.id && (
                            <Badge variant="warning">Préprod</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {site.status === "live" && site.liveReleaseId !== r.id && r.gitTag && (
                          <RollbackButton
                            siteId={site.id}
                            releaseId={r.id}
                            version={r.version}
                            disabled={Boolean(
                              running &&
                              running.status !== "succeeded" &&
                              running.status !== "failed",
                            )}
                          />
                        )}
                        {site.stagingReleaseId !== r.id &&
                          site.liveReleaseId !== r.id &&
                          !r.gitTag && (
                            <Button size="sm" variant="ghost" asChild>
                              <Link href={`/deploy/${site.id}/step-4?release=${r.id}`}>
                                Mettre en ligne
                              </Link>
                            </Button>
                          )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {site.releases.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center">
                        Aucune version pour l'instant.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Historique des déploiements</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Résultat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {site.deployments.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <Link
                          href={`/sites/${site.id}?deployment=${d.id}`}
                          className="hover:underline"
                        >
                          {formatDateTime(d.createdAt)}
                        </Link>
                      </TableCell>
                      <TableCell>{DEPLOY_KIND_LABEL[d.kind]}</TableCell>
                      <TableCell>{d.release ? `v${d.release.version}` : "—"}</TableCell>
                      <TableCell>
                        <DeployStatusBadge status={d.status} />
                        {d.error && (
                          <div
                            className="text-destructive mt-1 max-w-xs truncate text-xs"
                            title={d.error}
                          >
                            {d.error}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MailIcon className="size-4" /> Messages reçus
            </CardTitle>
            <CardDescription>
              {site.formsEmail
                ? `Transmis à ${site.formsEmail}`
                : "Aucune adresse de réception configurée"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {site.submissions.length === 0 && (
              <p className="text-muted-foreground text-sm">Aucun message pour l'instant.</p>
            )}
            {site.submissions.map((s) => {
              const p = s.payload as Record<string, string>;
              return (
                <div key={s.id} className="rounded-lg border p-3 text-sm">
                  <div className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
                    <span>
                      {p.nom ?? p.name ?? p.email ?? "Anonyme"}
                      {p.email && p.nom ? ` · ${p.email}` : ""}
                    </span>
                    <span>{formatDateTime(s.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap">
                    {p.message ?? p.msg ?? Object.values(p).join(" · ")}
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
