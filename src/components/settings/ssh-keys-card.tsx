"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { generateSshKeysAction, importSshKeyAction } from "@/server/actions/settings";

export function SshKeysCard({ publicKey }: { publicKey: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [privateKey, setPrivateKey] = useState("");
  const [showImport, setShowImport] = useState(false);

  function generate() {
    if (
      publicKey &&
      !confirm(
        "Une clé existe déjà. En générer une nouvelle rendra les serveurs déjà installés inaccessibles tant que leur fichier authorized_keys n'est pas mis à jour. Continuer ?",
      )
    )
      return;
    startTransition(async () => {
      const res = await generateSshKeysAction();
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Paire de clés générée (${res.fingerprint})`);
      router.refresh();
    });
  }

  function importKey() {
    startTransition(async () => {
      const res = await importSshKeyAction(privateKey);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Clé importée (${res.fingerprint})`);
      setPrivateKey("");
      setShowImport(false);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRoundIcon className="size-4" /> SSH du pilote
          {publicKey ? (
            <Badge variant="success">Clé prête</Badge>
          ) : (
            <Badge variant="outline">Aucune clé</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Paire de clés avec laquelle l'outil pilote les serveurs. La clé privée reste chiffrée en
          base ; la clé publique est installée sur chaque serveur par le script d'installation.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {publicKey && (
          <div className="flex flex-col gap-1.5">
            <Label>Clé publique</Label>
            <div className="flex items-start gap-2">
              <code className="bg-muted flex-1 rounded-md p-2 text-xs break-all">{publicKey}</code>
              <Button
                size="icon"
                variant="outline"
                onClick={() =>
                  navigator.clipboard
                    .writeText(publicKey)
                    .then(() => toast.success("Clé publique copiée"))
                }
                title="Copier"
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
        )}
        {showImport && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-import">Clé privée OpenSSH existante</Label>
            <Textarea
              id="ssh-import"
              rows={5}
              className="font-mono text-xs"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          {showImport ? (
            <>
              <Button variant="outline" onClick={() => setShowImport(false)} disabled={pending}>
                Annuler
              </Button>
              <Button onClick={importKey} disabled={pending || !privateKey.trim()}>
                {pending && <Loader2Icon className="animate-spin" />} Importer
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setShowImport(true)} disabled={pending}>
                Importer une clé
              </Button>
              <Button onClick={generate} disabled={pending} data-testid="generate-ssh-keys">
                {pending && <Loader2Icon className="animate-spin" />}{" "}
                {publicKey ? "Régénérer" : "Générer une paire de clés"}
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
