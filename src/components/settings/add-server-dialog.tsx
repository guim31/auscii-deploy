"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyIcon, Loader2Icon, PlusIcon } from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { addExistingServerAction } from "@/server/actions/settings";

export function AddServerDialog({
  script,
  sshReady,
  demo,
}: {
  script: string;
  sshReady: boolean;
  demo: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    ip: "",
    sshPort: "22",
    sshUser: "deploy",
    vcpus: "2",
    offer: "DEV1-S",
  });
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  function copyScript() {
    navigator.clipboard.writeText(script).then(() => toast.success("Script copié"));
  }

  function submit() {
    startTransition(async () => {
      const res = await addExistingServerAction(form);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Serveur ajouté, vérification de la connexion en cours");
      setOpen(false);
      setTimeout(() => router.refresh(), 1500);
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="add-server">
        <PlusIcon /> Ajouter un serveur existant
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent wide className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Ajouter un serveur existant</DialogTitle>
            <DialogDescription>
              Un VPS Debian 12 que vous avez créé vous-même. Lancez d'abord le script d'installation
              en root, puis renseignez le serveur ici : l'outil vérifie la connexion SSH et relève
              ses métriques.
            </DialogDescription>
          </DialogHeader>

          {!sshReady && !demo && (
            <Alert variant="warning">
              <AlertTitle>Clé SSH du pilote absente</AlertTitle>
              <AlertDescription>
                Générez-la dans Intégrations &gt; SSH avant de lancer le script : elle y est
                incluse.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>1. Script à lancer en root sur le serveur</Label>
              <Button size="sm" variant="ghost" onClick={copyScript}>
                <CopyIcon /> Copier
              </Button>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-200">
              {script}
            </pre>
            <p className="text-muted-foreground text-xs">
              Par exemple : collez le script dans <code>/root/bootstrap.sh</code> puis{" "}
              <code>bash /root/bootstrap.sh</code>. Il installe Caddy, Docker, le pare-feu et
              l'utilisateur <code>deploy</code>.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>2. Coordonnées du serveur</Label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-name">Nom</Label>
              <Input id="srv-name" placeholder="vps-01" value={form.name} onChange={set("name")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-ip">Adresse IP</Label>
              <Input id="srv-ip" placeholder="51.15.0.10" value={form.ip} onChange={set("ip")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-user">Utilisateur SSH</Label>
              <Input id="srv-user" value={form.sshUser} onChange={set("sshUser")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-port">Port SSH</Label>
              <Input id="srv-port" type="number" value={form.sshPort} onChange={set("sshPort")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-vcpus">vCPU</Label>
              <Input id="srv-vcpus" type="number" value={form.vcpus} onChange={set("vcpus")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="srv-offer">Offre (information)</Label>
              <Input id="srv-offer" value={form.offer} onChange={set("offer")} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              onClick={submit}
              disabled={pending || !form.name || !form.ip}
              data-testid="add-server-submit"
            >
              {pending && <Loader2Icon className="animate-spin" />} Ajouter et vérifier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
