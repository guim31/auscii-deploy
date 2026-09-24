import Link from "next/link";
import { ServerIcon, AlertTriangleIcon } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { CapacityVerdict } from "@/server/capacity";

export type ServerSummary = {
  id: string;
  name: string;
  status: string;
  sitesCount: number;
  verdict: CapacityVerdict;
};

const STATUS_LABEL: Record<string, string> = {
  ordering: "commande en cours",
  bootstrapping: "installation",
  error: "en erreur",
  retiring: "suppression",
  retired: "retiré",
  unreachable: "injoignable",
};

export function ServersBanner({ servers }: { servers: ServerSummary[] }) {
  if (servers.length === 0) {
    return (
      <div className="text-muted-foreground mb-6 flex items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
        <ServerIcon className="size-4" />
        Aucun serveur pour l'instant. Le premier sera commandé automatiquement lors du premier
        déploiement.
      </div>
    );
  }
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {servers.map((s) => {
        const ready = s.status === "ready";
        const tone =
          !ready && (s.status === "error" || s.status === "unreachable")
            ? "destructive"
            : !ready
              ? "warning"
              : s.verdict.level === "full"
                ? "destructive"
                : s.verdict.level === "warn"
                  ? "warning"
                  : "success";
        return (
          <Link
            key={s.id}
            href="/settings/servers"
            className="bg-card hover:bg-accent/40 rounded-lg border px-4 py-3 text-sm transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-medium">
                <ServerIcon className="text-muted-foreground size-4" /> {s.name}
              </span>
              <span className="text-muted-foreground text-xs">
                {ready
                  ? `${s.sitesCount} site${s.sitesCount > 1 ? "s" : ""}`
                  : (STATUS_LABEL[s.status] ?? s.status)}
              </span>
            </div>
            <Progress value={ready ? s.verdict.usagePct : 0} tone={tone} className="mt-2" />
            <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
              {(s.verdict.level === "full" || tone === "destructive") && (
                <AlertTriangleIcon className="text-destructive size-3" />
              )}
              {!ready
                ? s.status === "unreachable"
                  ? "Ne répond plus : voir Paramètres > Serveurs"
                  : s.status === "error"
                    ? "Voir Paramètres > Serveurs"
                    : "Pas encore disponible"
                : s.verdict.level === "full"
                  ? "Capacité atteinte"
                  : s.verdict.level === "warn"
                    ? "Charge élevée"
                    : `Charge ${s.verdict.usagePct} %`}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
