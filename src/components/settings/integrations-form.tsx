"use client";

import { useState, useTransition } from "react";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveIntegrationAction, testIntegrationAction } from "@/server/actions/settings";
import type { IntegrationName } from "@/server/providers";
import { formatDateTime } from "@/lib/format";

export type IntegrationState = {
  name: IntegrationName;
  configured: boolean;
  updatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
};

const FIELDS: Record<
  IntegrationName,
  {
    title: string;
    description: string;
    phase: string;
    fields: {
      key: string;
      label: string;
      secret?: boolean;
      multiline?: boolean;
      placeholder?: string;
    }[];
  }
> = {
  gandi: {
    title: "Gandi",
    description:
      "Achat des domaines et DNS (LiveDNS). Jeton personnel (PAT) avec les droits « Voir et renouveler les domaines », « Acheter des domaines » et « Gérer les enregistrements LiveDNS ».",
    phase: "phase 3",
    fields: [
      { key: "apiKey", label: "Personal Access Token", secret: true },
      {
        key: "organizationId",
        label: "Identifiant d'organisation (sharing_id)",
        placeholder: "facultatif",
      },
    ],
  },
  scaleway: {
    title: "Scaleway",
    description:
      "Commande et suppression des serveurs (Instances). Clé API IAM avec la permission InstancesFullAccess sur le projet, et l'identifiant du projet (UUID).",
    phase: "phase 4 (livrée)",
    fields: [
      { key: "secretKey", label: "Secret key", secret: true },
      { key: "projectId", label: "Project ID" },
    ],
  },
  github: {
    title: "GitHub",
    description:
      "GitHub App installée sur l'organisation, un dépôt privé par site. Permissions : Contents (lecture/écriture), Administration (lecture/écriture), Metadata (lecture). L'Installation ID est dans l'URL de la page d'installation.",
    phase: "phase 5 (livrée)",
    fields: [
      { key: "org", label: "Organisation", placeholder: "auscii" },
      { key: "appId", label: "App ID" },
      { key: "installationId", label: "Installation ID" },
      { key: "privateKey", label: "Clé privée (PEM)", secret: true, multiline: true },
    ],
  },
  resend: {
    title: "Resend",
    description: "Envoi des messages des formulaires de contact.",
    phase: "phase 6",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      { key: "from", label: "Expéditeur", placeholder: "AUSCII <no-reply@auscii.site>" },
    ],
  },
  anthropic: {
    title: "Anthropic",
    description: "Rapport d'analyse Claude à l'étape 3.",
    phase: "phase 7",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      { key: "model", label: "Modèle", placeholder: "claude-sonnet-5" },
    ],
  },
  ssh: {
    title: "SSH du pilote",
    description:
      "Paire de clés utilisée pour piloter les serveurs. La clé publique est injectée dans chaque serveur commandé.",
    phase: "phase 2",
    fields: [
      { key: "publicKey", label: "Clé publique", multiline: true },
      { key: "privateKey", label: "Clé privée", secret: true, multiline: true },
    ],
  },
};

function IntegrationCard({ state }: { state: IntegrationState }) {
  const def = FIELDS[state.name];
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await saveIntegrationAction(state.name, values);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${def.title} enregistré`);
        setValues({});
      }
    });
  }
  function test() {
    startTransition(async () => {
      const res = await testIntegrationAction(state.name);
      if (!res.ok) toast.error(res.error);
      else toast.success(res.message);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {def.title}
          {state.configured ? (
            <Badge variant="success">
              <CheckCircle2Icon /> Configurée
            </Badge>
          ) : (
            <Badge variant="outline">Non configurée</Badge>
          )}
          <span className="text-muted-foreground ml-auto text-xs font-normal">
            intégration réelle en {def.phase}
          </span>
        </CardTitle>
        <CardDescription>
          {def.description}
          {state.updatedAt && <> · mise à jour {formatDateTime(state.updatedAt)}</>}
          {state.lastTestAt && (
            <>
              {" "}
              · dernier test {formatDateTime(state.lastTestAt)} :{" "}
              {state.lastTestOk ? "ok" : "échec"}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {def.fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${state.name}-${f.key}`}>{f.label}</Label>
            {f.multiline ? (
              <Textarea
                id={`${state.name}-${f.key}`}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                placeholder={state.configured && f.secret ? "•••••• (enregistrée)" : f.placeholder}
                className="font-mono text-xs"
                rows={3}
              />
            ) : (
              <Input
                id={`${state.name}-${f.key}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                placeholder={state.configured && f.secret ? "•••••• (enregistrée)" : f.placeholder}
              />
            )}
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={test} disabled={pending || !state.configured}>
            Tester
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />} Enregistrer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function IntegrationsForm({ state }: { state: IntegrationState[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {state.map((s) => (
        <IntegrationCard key={s.name} state={s} />
      ))}
    </div>
  );
}
