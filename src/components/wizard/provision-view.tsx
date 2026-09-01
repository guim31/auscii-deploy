"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DeployConsole, type ConsoleLog, type ConsoleState } from "./deploy-console";
import { retryDeploymentAction } from "@/server/actions/sites";

export function ProvisionView({
  siteId,
  deploymentId,
  initialState,
  initialLogs,
}: {
  siteId: string;
  deploymentId: string;
  initialState: ConsoleState;
  initialLogs: ConsoleLog[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialState.status);
  const [pending, startTransition] = useTransition();

  function retry() {
    startTransition(async () => {
      const res = await retryDeploymentAction(deploymentId);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Reprise du provisioning");
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Préparation de l'infrastructure</CardTitle>
        <CardDescription>
          Serveur, nom de domaine, DNS, dépôt GitHub et configuration du serveur web. Chaque étape
          est reprise automatiquement en cas d'incident.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DeployConsole
          key={deploymentId + status}
          deploymentId={deploymentId}
          initialState={initialState}
          initialLogs={initialLogs}
          onFinished={(s) => {
            setStatus(s);
            router.refresh();
          }}
        />
        <div className="flex justify-end gap-2">
          {status === "failed" && (
            <Button variant="outline" onClick={retry} disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />} Réessayer
            </Button>
          )}
          <Button asChild disabled={status !== "succeeded"} data-testid="go-step-3">
            <Link
              href={status === "succeeded" ? `/deploy/${siteId}/step-3` : "#"}
              aria-disabled={status !== "succeeded"}
              className={status !== "succeeded" ? "pointer-events-none opacity-50" : ""}
            >
              Déposer le site <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
