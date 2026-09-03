"use client";

import { useState, useTransition } from "react";
import { Loader2Icon, MailCheckIcon, SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  sendTestEmailAction,
  setupSendingDomainAction,
  type SendingDomainView,
} from "@/server/actions/settings";

/** Sending-domain setup and test email, shown under the Resend integration card. */
export function ResendDomainPanel({
  configured,
  techDomain,
  defaultSender,
}: {
  configured: boolean;
  techDomain: string;
  defaultSender: string;
}) {
  const [domain, setDomain] = useState<SendingDomainView | null>(null);
  const [pending, startTransition] = useTransition();

  function setup() {
    startTransition(async () => {
      const res = await setupSendingDomainAction();
      if (!res.ok) return void toast.error(res.error);
      setDomain(res.domain);
      toast.success(
        res.domain.status === "verified"
          ? `Domaine ${res.domain.name} vérifié`
          : `Domaine ${res.domain.name} déclaré, vérification en cours`,
      );
    });
  }
  function sendTest() {
    startTransition(async () => {
      const res = await sendTestEmailAction();
      if (!res.ok) toast.error(res.error);
      else toast.success(res.message);
    });
  }

  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-3" data-testid="resend-domain-panel">
      <p className="text-muted-foreground text-xs">
        Les emails partent de <span className="font-mono">{defaultSender}</span> sauf expéditeur
        personnalisé. Resend doit vérifier le domaine{" "}
        <span className="font-mono">{techDomain}</span> (enregistrements SPF et DKIM) : le bouton le
        déclare chez Resend et écrit les enregistrements dans LiveDNS quand Gandi est configuré.
      </p>
      {domain && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <MailCheckIcon className="size-4" />
            <span className="font-mono">{domain.name}</span>
            <Badge variant={domain.status === "verified" ? "success" : "outline"}>
              {domain.statusLabel}
            </Badge>
          </div>
          {domain.records.length > 0 && (
            <>
              <p className="text-muted-foreground text-xs">
                {domain.dnsWritten
                  ? "Enregistrements écrits dans LiveDNS. La vérification peut prendre quelques minutes : relancez le bouton pour actualiser l'état."
                  : "Gandi n'est pas configuré : créez ces enregistrements dans la zone DNS du domaine technique."}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nom</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Valeur</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domain.records.map((r) => (
                    <TableRow key={`${r.name}-${r.type}`}>
                      <TableCell className="font-mono text-xs">{r.name}</TableCell>
                      <TableCell>{r.type}</TableCell>
                      <TableCell className="font-mono text-xs break-all">
                        {r.values.join(" ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={sendTest} disabled={pending || !configured}>
          {pending ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Envoyer un email de
          test
        </Button>
        <Button variant="outline" size="sm" onClick={setup} disabled={pending || !configured}>
          {pending ? <Loader2Icon className="animate-spin" /> : <MailCheckIcon />} Configurer le
          domaine d'envoi
        </Button>
      </div>
    </div>
  );
}
