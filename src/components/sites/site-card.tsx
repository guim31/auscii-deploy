"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ExternalLinkIcon,
  EyeIcon,
  LockIcon,
  ServerIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SiteStatusBadge } from "@/components/app/status-badge";
import { formatDate, formatDateTime, daysUntil } from "@/lib/format";
import type { SiteStatus } from "@prisma/client";

export type SiteCardData = {
  id: string;
  clientName: string;
  domain: string | null;
  previewHost: string | null;
  previewToken: string;
  status: SiteStatus;
  serverName: string | null;
  screenshot: boolean;
  lastPublishedAt: string | null;
  ssl: { ok: boolean; issuer: string | null; expiresAt: string | null } | null;
  domainExpiresAt: string | null;
  domainAutorenew: boolean;
  liveReleaseId: string | null;
  stagingReleaseId: string | null;
  demo: boolean;
};

export function SiteCard({ site }: { site: SiteCardData }) {
  const [open, setOpen] = useState(false);
  const previewReleaseId = site.liveReleaseId ?? site.stagingReleaseId;
  const previewSrc = previewReleaseId ? `/api/preview/${previewReleaseId}/` : null;
  const liveUrl = site.domain ? `https://${site.domain}` : null;
  const days = daysUntil(site.ssl?.expiresAt);
  const domainDays = daysUntil(site.domainExpiresAt);
  const domainWarning = domainDays !== null && domainDays < 30 && !site.domainAutorenew;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="bg-muted relative aspect-[16/10]">
        {site.screenshot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/screenshots/${site.id}`}
            alt={`Aperçu de ${site.clientName}`}
            className="size-full object-cover"
          />
        ) : (
          <div className="text-muted-foreground flex size-full items-center justify-center text-sm">
            Pas encore de capture
          </div>
        )}
        <div className="absolute top-2 left-2">
          <SiteStatusBadge status={site.status} />
        </div>
      </div>
      <CardContent className="flex flex-col gap-3 py-4">
        <div>
          <Link href={`/sites/${site.id}`} className="font-semibold hover:underline">
            {site.clientName}
          </Link>
          <div className="text-muted-foreground truncate text-sm">
            {site.domain ?? "Domaine à définir"}
          </div>
        </div>
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="flex items-center gap-1">
            <ServerIcon className="size-3.5" /> Serveur
          </dt>
          <dd className="text-foreground truncate">{site.serverName ?? "—"}</dd>
          <dt className="flex items-center gap-1">
            {site.ssl?.ok ? (
              <ShieldCheckIcon className="text-success size-3.5" />
            ) : (
              <ShieldAlertIcon className="size-3.5" />
            )}{" "}
            HTTPS
          </dt>
          <dd className="text-foreground truncate">
            {site.ssl?.ok ? (
              <>
                {site.ssl.issuer ?? "Valide"}
                {days !== null && (
                  <span
                    className={days < 14 ? "text-destructive ml-1" : "text-muted-foreground ml-1"}
                  >
                    · expire le {formatDate(site.ssl.expiresAt)}
                  </span>
                )}
              </>
            ) : site.status === "live" ? (
              "Vérification en attente"
            ) : (
              "—"
            )}
          </dd>
          {domainWarning && (
            <>
              <dt className="text-destructive">Domaine</dt>
              <dd className="text-destructive">
                expire le {formatDate(site.domainExpiresAt)}, renouvellement non automatique
              </dd>
            </>
          )}
          <dt>Publié</dt>
          <dd className="text-foreground">
            {site.lastPublishedAt ? formatDateTime(site.lastPublishedAt) : "Pas encore"}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!previewSrc}>
            <EyeIcon /> Voir
          </Button>
          {liveUrl && site.status === "live" && !site.demo && (
            <Button size="sm" variant="ghost" asChild>
              <a href={liveUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon /> Ouvrir
              </a>
            </Button>
          )}
          {site.previewHost && site.stagingReleaseId && !site.demo && (
            <Button size="sm" variant="ghost" asChild>
              <a
                href={`https://${site.previewHost}/__preview/${site.previewToken}`}
                target="_blank"
                rel="noreferrer"
              >
                <LockIcon /> Préprod
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild className="ml-auto">
            <Link href={`/sites/${site.id}`}>Détails</Link>
          </Button>
        </div>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent wide className="h-[85vh] p-0">
          <DialogHeader className="border-b px-6 pt-6 pb-4">
            <DialogTitle>{site.clientName}</DialogTitle>
            <DialogDescription>
              {site.domain ?? site.previewHost ?? "Aperçu"} · version{" "}
              {site.liveReleaseId ? "en ligne" : "en préproduction"}
            </DialogDescription>
          </DialogHeader>
          {previewSrc && (
            <iframe
              src={previewSrc}
              title={`Aperçu de ${site.clientName}`}
              className="size-full flex-1 rounded-b-xl bg-white"
              sandbox="allow-scripts allow-forms"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
