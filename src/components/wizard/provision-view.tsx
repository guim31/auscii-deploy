"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DeployConsole, type ConsoleLog, type ConsoleState } from "./deploy-console";
import { confirmServerOrderAction, retryDeploymentAction } from "@/server/actions/sites";
import { SERVER_ORDER_CONFIRMATION_REQUIRED } from "@/lib/messages";
import { formatEuro } from "@/lib/format";

export function ProvisionView({
  siteId,
  deploymentId,
  initialState,
  initialLogs,
  isAdmin,
}: {
  siteId: string;
  deploymentId: string;
  initialState: ConsoleState;
  initialLogs: ConsoleLog[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialState.status);
  const [error, setError] = useState(initialState.error ?? null);
  // Bumped on each retry so a fresh console (and stream) takes over.
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const needsOrder = status === "failed" && error === SERVER_ORDER_CONFIRMATION_REQUIRED;

  function restarted(message: string) {
    toast.success(message);
    setStatus("queued");
    setError(null);
    setAttempt((a) => a + 1);
    router.refresh();
  }

  function retry() {
    startTransition(async () => {
      const res = await retryDeploymentAction(deploymentId);
      if (!res.ok) toast.error(res.error);
      else restarted("Reprise de la préparation");
    });
  }

  function confirmOrder() {
    if (
      !window.confirm(
        "Commander un nouveau serveur ? Il sera facturé chaque mois jusqu'à sa suppression.",
      )
    )
      return;
    startTransition(async () => {
      const res = await confirmServerOrderAction(deploymentId);
      if (!res.ok) toast.error(res.error);
      else
        restarted(
          res.price > 0
            ? `Commande confirmée (${formatEuro(res.price)}/mois), reprise en cours`
            : "Un serveur est disponible, reprise en cours",
        );
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
          key={`${deploymentId}:${attempt}`}
          deploymentId={deploymentId}
          initialState={
            attempt === 0 ? initialState : { ...initialState, status: "queued", error: null }
          }
          initialLogs={attempt === 0 ? initialLogs : []}
          onFinished={(s) => {
            setStatus(s);
            // The page re-renders with the new state (and its error) and remounts this view.
            router.refresh();
          }}
        />
        <div className="flex justify-end gap-2">
          {needsOrder && isAdmin && (
            <Button onClick={confirmOrder} disabled={pending} data-testid="confirm-server-order">
              {pending && <Loader2Icon className="animate-spin" />} Commander un serveur et
              reprendre
            </Button>
          )}
          {needsOrder && !isAdmin && (
            <p className="text-muted-foreground mr-auto self-center text-sm">
              Demandez à un administrateur de confirmer la commande d'un serveur.
            </p>
          )}
          {status === "failed" && !needsOrder && (
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
