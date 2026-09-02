"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, Trash2Icon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteServerAction } from "@/server/actions/settings";
import { formatEuro } from "@/lib/format";

export function DeleteServerDialog({
  server,
}: {
  server: {
    id: string;
    name: string;
    ip: string | null;
    offer: string;
    provider: string;
    monthlyPrice: number | null;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const cloud = server.provider !== "manual";

  function confirm() {
    startTransition(async () => {
      const res = await deleteServerAction(server.id, name);
      if (!res.ok) return void toast.error(res.error);
      toast.success(cloud ? "Suppression lancée chez le fournisseur" : "Serveur retiré de l'outil");
      setOpen(false);
      setName("");
      setTimeout(() => router.refresh(), 1500);
    });
  }

  return (
    <>
      <button
        type="button"
        className="underline"
        onClick={() => setOpen(true)}
        data-testid={`delete-server-${server.name}`}
      >
        {cloud ? "Supprimer" : "Retirer"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {cloud
                ? `Supprimer ${server.name} chez le fournisseur ?`
                : `Retirer ${server.name} de l'outil ?`}
            </DialogTitle>
            <DialogDescription>
              {cloud
                ? `L'instance ${server.offer} (${server.ip ?? "IP inconnue"}), ses volumes et son adresse IP seront supprimés définitivement. La facturation${server.monthlyPrice ? ` (${formatEuro(server.monthlyPrice)}/mois)` : ""} s'arrête immédiatement.`
                : "Ce serveur a été installé à la main : il sera seulement retiré de la liste. Pensez à le supprimer chez votre hébergeur pour arrêter sa facturation."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-server-name">Saisissez le nom du serveur pour confirmer</Label>
            <Input
              id="confirm-server-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={server.name}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={confirm}
              disabled={pending || name.trim() !== server.name}
              data-testid="confirm-delete-server"
            >
              {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}{" "}
              {cloud ? "Supprimer définitivement" : "Retirer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
