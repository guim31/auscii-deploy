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
import {
  deleteIntegrationAction,
  saveIntegrationAction,
  testIntegrationAction,
} from "@/server/actions/settings";
import type { IntegrationName } from "@/server/providers";
import { formatDateTime } from "@/lib/format";
import { ResendDomainPanel } from "./resend-domain-panel";

export type IntegrationState = {
  name: IntegrationName;
  configured: boolean;
  updatedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  /** Saved values of the non-secret fields (organisation, identifiers…), shown for editing. */
  values: Record<string, string>;
};

const FIELDS: Record<
  Exclude<IntegrationName, "ssh">,
  {
    title: string;
    description: string;
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
      "Commande et suppression des serveurs (Instances). Clé API IAM avec les permissions InstancesFullAccess et BlockStorageFullAccess sur le projet, et l'identifiant du projet (UUID).",
    fields: [
      { key: "secretKey", label: "Secret key", secret: true },
      { key: "projectId", label: "Project ID" },
    ],
  },
  github: {
    title: "GitHub",
    description:
      "GitHub App installée sur l'organisation GitHub de l'agence (pas sur un compte personnel), un dépôt privé par site. Permissions : Contents (lecture/écriture), Administration (lecture/écriture), Metadata (lecture). L'Installation ID est dans l'URL de la page d'installation.",
    fields: [
      { key: "org", label: "Organisation", placeholder: "auscii" },
      { key: "appId", label: "App ID" },
      { key: "installationId", label: "Installation ID" },
      { key: "privateKey", label: "Clé privée (PEM)", secret: true, multiline: true },
    ],
  },
  resend: {
    title: "Resend",
    description:
      "Messages des formulaires de contact et alertes à l'agence. Clé API avec accès complet (les domaines sont gérés depuis l'outil).",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      {
        key: "from",
        label: "Expéditeur (facultatif)",
        placeholder: "AUSCII <no-reply@auscii.site>",
      },
    ],
  },
  anthropic: {
    title: "Anthropic",
    description:
      "Rapport de relecture Claude à l'étape 3 (SEO, accessibilité, contenu). Clé API de la console Anthropic ; le modèle est facultatif.",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      { key: "model", label: "Modèle (facultatif)", placeholder: "claude-opus-5 par défaut" },
    ],
  },
};

type MailContext = { techDomain: string; defaultSender: string };

function IntegrationCard({ state, mail }: { state: IntegrationState; mail: MailContext }) {
  const def = FIELDS[state.name as Exclude<IntegrationName, "ssh">];
  const [values, setValues] = useState<Record<string, string>>(state.values);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await saveIntegrationAction(state.name, values);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${def.title} enregistré`);
        // Secrets are never shown back; the other fields keep what was saved.
        setValues(
          Object.fromEntries(
            def.fields.filter((f) => !f.secret).map((f) => [f.key, values[f.key] ?? ""]),
          ),
        );
      }
    });
  }
  function remove() {
    if (
      !window.confirm(
        `Supprimer les clés ${def.title} ? Les fonctions qui en dépendent s'arrêteront.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await deleteIntegrationAction(state.name);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${def.title} supprimé`);
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
                placeholder={
                  state.configured && f.secret
                    ? "•••••• (enregistrée, laissez vide pour la garder)"
                    : f.placeholder
                }
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
                placeholder={
                  state.configured && f.secret
                    ? "•••••• (enregistrée, laissez vide pour la garder)"
                    : f.placeholder
                }
              />
            )}
          </div>
        ))}
        <div className="flex justify-end gap-2">
          {state.configured && (
            <Button variant="ghost" onClick={remove} disabled={pending} className="mr-auto">
              Supprimer
            </Button>
          )}
          <Button variant="outline" onClick={test} disabled={pending || !state.configured}>
            Tester
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />} Enregistrer
          </Button>
        </div>
        {state.name === "resend" && (
          <ResendDomainPanel
            configured={state.configured}
            techDomain={mail.techDomain}
            defaultSender={mail.defaultSender}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsForm({
  state,
  mail,
}: {
  state: IntegrationState[];
  mail: MailContext;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {state.map((s) => (
        <IntegrationCard key={s.name} state={s} mail={mail} />
      ))}
    </div>
  );
}
