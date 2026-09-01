import type { DeployStatus, SiteStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";

const SITE: Record<
  SiteStatus,
  {
    label: string;
    variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline";
  }
> = {
  draft: { label: "Brouillon", variant: "outline" },
  provisioning: { label: "Préparation", variant: "warning" },
  ready: { label: "Prêt", variant: "secondary" },
  preview: { label: "En préproduction", variant: "warning" },
  live: { label: "En ligne", variant: "success" },
  error: { label: "Erreur", variant: "destructive" },
};

const DEPLOY: Record<
  DeployStatus,
  {
    label: string;
    variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline";
  }
> = {
  queued: { label: "En attente", variant: "outline" },
  running: { label: "En cours", variant: "warning" },
  succeeded: { label: "Réussi", variant: "success" },
  failed: { label: "Échoué", variant: "destructive" },
};

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  const s = SITE[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function DeployStatusBadge({ status }: { status: DeployStatus }) {
  const s = DEPLOY[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export const DEPLOY_KIND_LABEL = {
  provision: "Provisioning",
  deploy: "Préproduction",
  promote: "Production",
  rollback: "Retour arrière",
} as const;
