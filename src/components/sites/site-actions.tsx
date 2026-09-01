"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HistoryIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { startRollbackAction } from "@/server/actions/sites";

export function RollbackButton({
  siteId,
  releaseId,
  version,
  disabled,
}: {
  siteId: string;
  releaseId: string;
  version: number;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  function go() {
    startTransition(async () => {
      const res = await startRollbackAction(siteId, releaseId);
      setOpen(false);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Retour à la version ${version} lancé`);
      router.push(`/sites/${siteId}?deployment=${res.deploymentId}`);
      router.refresh();
    });
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled || pending}
        data-testid={`rollback-${version}`}
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <HistoryIcon />} Remettre en ligne
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revenir à la version {version} ?</DialogTitle>
            <DialogDescription>
              La version {version} remplacera immédiatement la version en production. Aucune donnée
              n'est perdue, les autres versions restent disponibles.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button onClick={go} data-testid="confirm-rollback">
              Confirmer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
