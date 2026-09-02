"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PlusIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import {
  orderServerAction,
  refreshMetricsAction,
  retestServerAction,
} from "@/server/actions/settings";
import { DeleteServerDialog } from "./delete-server-dialog";
import { AddServerDialog } from "./add-server-dialog";
import type { CapacityVerdict } from "@/server/capacity";
import type { ServerMetrics } from "@/server/providers/types";
import type { CapacityThresholds } from "@/server/settings";
import { formatBytes } from "@/server/capacity";
import { formatEuro, formatDateTime, relativeTime } from "@/lib/format";

export type ServerRow = {
  id: string;
  name: string;
  status: string;
  provider: string;
  ip: string | null;
  offer: string;
  zone: string;
  monthlyPrice: number | null;
  sitesCount: number;
  metrics: ServerMetrics | null;
  verdict: CapacityVerdict;
  createdAt: string;
};

const STATUS: Record<
  string,
  { label: string; variant: "success" | "warning" | "destructive" | "outline" | "secondary" }
> = {
  ready: { label: "Prêt", variant: "success" },
  ordering: { label: "Commande", variant: "warning" },
  bootstrapping: { label: "Installation", variant: "warning" },
  error: { label: "Erreur", variant: "destructive" },
  retiring: { label: "Suppression", variant: "warning" },
  retired: { label: "Retiré", variant: "outline" },
};

function Gauge({ label, pct, max }: { label: string; pct: number; max: number }) {
  const tone = pct >= max ? "destructive" : pct >= max * 0.7 ? "warning" : "success";
  return (
    <div className="text-xs">
      <div className="text-muted-foreground flex justify-between">
        <span>{label}</span>
        <span>{Math.round(pct)} %</span>
      </div>
      <Progress value={(pct / max) * 100} tone={tone} className="mt-1 h-1.5" />
    </div>
  );
}

export function ServersTable({
  servers,
  offers,
  defaultOffer,
  isAdmin,
  thresholds,
  bootstrap,
  sshReady,
  demo,
}: {
  bootstrap: string;
  sshReady: boolean;
  demo: boolean;
  servers: ServerRow[];
  offers: { id: string; monthlyPrice: number; vcpus: number; ramGb: number; diskGb: number }[];
  defaultOffer: string;
  isAdmin: boolean;
  thresholds: CapacityThresholds;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState(defaultOffer);
  const [pending, startTransition] = useTransition();
  const selected = offers.find((o) => o.id === offer);

  function refresh() {
    startTransition(async () => {
      const res = await refreshMetricsAction();
      if (!res.ok) toast.error(res.error);
      else toast.success(`Métriques relevées sur ${res.count} serveur(s)`);
      router.refresh();
    });
  }

  function order() {
    startTransition(async () => {
      const res = await orderServerAction(offer, selected?.monthlyPrice ?? null);
      setOpen(false);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Commande envoyée, le serveur apparaîtra dans quelques instants");
      setTimeout(() => router.refresh(), 2500);
    });
  }

  function retest(id: string, forgetHostKey: boolean) {
    startTransition(async () => {
      const res = await retestServerAction(id, forgetHostKey);
      if (!res.ok) toast.error(res.error);
      else toast.success("Vérification relancée");
      setTimeout(() => router.refresh(), 1500);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={refresh} disabled={pending}>
          {pending ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Relever les
          métriques
        </Button>
        {isAdmin && <AddServerDialog script={bootstrap} sshReady={sshReady} demo={demo} />}
        {isAdmin && (
          <Button onClick={() => setOpen(true)}>
            <PlusIcon /> Commander un serveur
          </Button>
        )}
      </div>
      {servers.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          Aucun serveur. Le premier sera commandé lors du premier déploiement, ou dès maintenant
          avec le bouton ci-dessus.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {servers.map((s) => {
          const m = s.metrics;
          return (
            <Card key={s.id} className="gap-3 py-4">
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex items-center gap-2">
                  <ServerIcon className="text-muted-foreground size-4" />
                  <span className="font-medium">{s.name}</span>
                  <Badge variant={STATUS[s.status]?.variant ?? "outline"}>
                    {STATUS[s.status]?.label ?? s.status}
                  </Badge>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {s.sitesCount} site{s.sitesCount > 1 ? "s" : ""}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {s.ip ?? "IP en attente"} · {s.offer} · {s.zone} ·{" "}
                  {s.monthlyPrice ? `${formatEuro(s.monthlyPrice)}/mois` : ""} · créé le{" "}
                  {formatDateTime(s.createdAt)}
                </div>
                {m ? (
                  <div className="grid grid-cols-3 gap-3">
                    <Gauge
                      label="CPU"
                      pct={(m.load15 / Math.max(1, m.vcpus)) * 100}
                      max={thresholds.loadPerVcpuMax * 100}
                    />
                    <Gauge label="Mémoire" pct={m.ramUsedPct} max={thresholds.ramUsedPctMax} />
                    <Gauge label="Disque" pct={m.diskUsedPct} max={thresholds.diskUsedPctMax} />
                  </div>
                ) : (
                  <div className="text-muted-foreground text-xs">Métriques non encore relevées</div>
                )}
                <div className="text-muted-foreground flex items-center justify-between text-xs">
                  <span>
                    {m
                      ? `${formatBytes(m.diskFreeBytes)} libres · relevé ${relativeTime(m.collectedAt)}`
                      : ""}
                    {s.status === "error" &&
                      (m as unknown as { lastError?: string } | null)?.lastError && (
                        <span className="text-destructive ml-2">
                          {(m as unknown as { lastError?: string }).lastError}
                        </span>
                      )}
                    {s.verdict.reasons.length > 0 && (
                      <span className="text-destructive ml-2">{s.verdict.reasons[0]}</span>
                    )}
                  </span>
                  {isAdmin && (s.status === "error" || s.status === "bootstrapping") && (
                    <span className="mr-3 flex gap-2">
                      <button
                        type="button"
                        className="underline"
                        onClick={() => retest(s.id, false)}
                        disabled={pending}
                      >
                        Retester
                      </button>
                      {s.status === "error" && (
                        <button
                          type="button"
                          className="underline"
                          onClick={() => retest(s.id, true)}
                          disabled={pending}
                          title="Après une réinstallation du serveur"
                        >
                          Oublier la clé d'hôte
                        </button>
                      )}
                    </span>
                  )}
                  {isAdmin &&
                    s.status !== "retired" &&
                    s.status !== "retiring" &&
                    s.sitesCount === 0 && (
                      <DeleteServerDialog
                        server={{
                          id: s.id,
                          name: s.name,
                          ip: s.ip,
                          offer: s.offer,
                          provider: s.provider,
                          monthlyPrice: s.monthlyPrice,
                        }}
                      />
                    )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commander un serveur</DialogTitle>
            <DialogDescription>
              Le serveur est créé chez Scaleway, installé automatiquement (Caddy, Docker, pare-feu)
              et prêt en quelques minutes. Cette action est facturée mensuellement.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <NativeSelect value={offer} onChange={(e) => setOffer(e.target.value)}>
              {offers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · {o.vcpus} vCPU · {o.ramGb} Go · {o.diskGb} Go ·{" "}
                  {formatEuro(o.monthlyPrice)}/mois
                </option>
              ))}
            </NativeSelect>
            {offers.length === 0 && (
              <p className="text-destructive text-sm">
                Offres indisponibles : configurez Scaleway ou activez le mode démo.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button onClick={order} disabled={pending || !selected}>
              Confirmer la commande{selected ? ` (${formatEuro(selected.monthlyPrice)}/mois)` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
