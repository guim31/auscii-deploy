"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  LockIcon,
  RocketIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DeployConsole, type ConsoleLog, type ConsoleState } from "./deploy-console";
import { startPromoteAction, startStagingAction } from "@/server/actions/sites";

export type DeploymentView = { id: string; state: ConsoleState; logs: ConsoleLog[] };

export function LaunchStep({
  siteId,
  releaseId,
  version,
  domain,
  previewUrl,
  previewSecretUrl,
  demo,
  stagingDone,
  liveDone,
  staging,
  promote,
}: {
  siteId: string;
  releaseId: string;
  version: number;
  domain: string;
  previewUrl: string;
  previewSecretUrl: string;
  demo: boolean;
  stagingDone: boolean;
  liveDone: boolean;
  staging: DeploymentView | null;
  promote: DeploymentView | null;
}) {
  const router = useRouter();
  const [stagingDeployment, setStagingDeployment] = useState(staging);
  const [promoteDeployment, setPromoteDeployment] = useState(promote);
  const [stagingOk, setStagingOk] = useState(stagingDone);
  const [liveOk, setLiveOk] = useState(liveDone);
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  function deployStaging() {
    startTransition(async () => {
      const res = await startStagingAction(siteId, releaseId);
      if (!res.ok) return void toast.error(res.error);
      setStagingOk(false);
      setStagingDeployment({
        id: res.deploymentId,
        state: { status: "queued", steps: [], error: null },
        logs: [],
      });
    });
  }

  function publish() {
    setConfirm(false);
    startTransition(async () => {
      const res = await startPromoteAction(siteId, releaseId);
      if (!res.ok) return void toast.error(res.error);
      setPromoteDeployment({
        id: res.deploymentId,
        state: { status: "queued", steps: [], error: null },
        logs: [],
      });
    });
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success("Lien copié"));
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockIcon className="size-4" /> 1. Préproduction
            {stagingOk && <CheckCircle2Icon className="text-success size-4" />}
          </CardTitle>
          <CardDescription>
            Version {version} déployée sur une adresse temporaire protégée, pour relecture interne
            et validation par le client.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {stagingDeployment && (
            <DeployConsole
              key={stagingDeployment.id}
              deploymentId={stagingDeployment.id}
              initialState={stagingDeployment.state}
              initialLogs={stagingDeployment.logs}
              compact
              onFinished={(s) => {
                if (s === "succeeded") {
                  setStagingOk(true);
                  toast.success("Préproduction en ligne");
                } else toast.error("La préproduction a échoué");
                router.refresh();
              }}
            />
          )}
          {stagingOk ? (
            <div
              className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
              data-testid="staging-ready"
            >
              <span className="font-medium">{previewUrl}</span>
              <Button size="sm" variant="outline" onClick={() => copy(previewSecretUrl)}>
                <CopyIcon /> Copier le lien secret
              </Button>
              {demo ? (
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/api/preview/${releaseId}/`} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon /> Aperçu local (démo)
                  </a>
                </Button>
              ) : (
                <Button size="sm" variant="ghost" asChild>
                  <a href={previewSecretUrl} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon /> Ouvrir
                  </a>
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={deployStaging}
                disabled={pending}
                className="ml-auto"
              >
                Redéployer
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                size="lg"
                onClick={deployStaging}
                disabled={pending || stagingDeployment?.state.status === "running"}
                data-testid="deploy-staging"
              >
                {pending ? <Loader2Icon className="animate-spin" /> : <LockIcon />} Déployer en
                préproduction
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={!stagingOk ? "opacity-60" : ""}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GlobeIcon className="size-4" /> 2. Production
            {liveOk && <CheckCircle2Icon className="text-success size-4" />}
          </CardTitle>
          <CardDescription>
            Fusion de staging vers production, publication sur {domain} et certificat HTTPS. Le site
            apparaît ensuite sur le tableau de bord.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {promoteDeployment && (
            <DeployConsole
              key={promoteDeployment.id}
              deploymentId={promoteDeployment.id}
              initialState={promoteDeployment.state}
              initialLogs={promoteDeployment.logs}
              compact
              onFinished={(s) => {
                if (s === "succeeded") {
                  setLiveOk(true);
                  toast.success(`${domain} est en ligne`);
                } else toast.error("La mise en production a échoué");
                router.refresh();
              }}
            />
          )}
          <div className="flex items-center justify-end gap-2">
            {liveOk ? (
              <Button asChild data-testid="back-dashboard">
                <Link href="/">Voir sur le tableau de bord</Link>
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => setConfirm(true)}
                disabled={!stagingOk || pending || promoteDeployment?.state.status === "running"}
                data-testid="publish"
              >
                <RocketIcon /> Publier en production
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publier {domain} ?</DialogTitle>
            <DialogDescription>
              La version {version}, actuellement en préproduction, sera mise en ligne sur {domain}{" "}
              et www.{domain}. Vous pourrez revenir à la version précédente à tout moment depuis la
              page du site.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Annuler
            </Button>
            <Button onClick={publish} data-testid="confirm-publish">
              <RocketIcon /> Publier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
