"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetDemoAction, saveAgencyAction } from "@/server/actions/settings";
import type { Settings } from "@/server/settings";

function Field({
  id,
  label,
  hint,
  ...props
}: React.ComponentProps<typeof Input> & { id: string; label: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function AgencyForm({ settings, demoForced }: { settings: Settings; demoForced: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>({
    agencyName: settings.agencyName,
    alertEmail: settings.alertEmail,
    techDomain: settings.techDomain,
    previewSubdomain: settings.previewSubdomain,
    defaultOffer: settings.defaultOffer,
    defaultZone: settings.defaultZone,
    gandiOrganizationId: settings.gandiContact.organizationId,
    gandiEmail: settings.gandiContact.email,
    gandiOrgName: settings.gandiContact.orgName,
    gandiGivenName: settings.gandiContact.givenName,
    gandiFamilyName: settings.gandiContact.familyName,
    gandiPhone: settings.gandiContact.phone,
    gandiStreet: settings.gandiContact.street,
    gandiZip: settings.gandiContact.zip,
    gandiCity: settings.gandiContact.city,
    gandiCountry: settings.gandiContact.country,
    diskUsedPctMax: String(settings.capacity.diskUsedPctMax),
    ramUsedPctMax: String(settings.capacity.ramUsedPctMax),
    loadPerVcpuMax: String(settings.capacity.loadPerVcpuMax),
    sitesHardCap: String(settings.capacity.sitesHardCap),
    warnPct: String(settings.capacity.warnPct),
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues({ ...values, [k]: e.target.value });

  function save() {
    startTransition(async () => {
      const res = await saveAgencyAction(values);
      if (!res.ok) toast.error(res.error);
      else toast.success("Paramètres enregistrés");
      router.refresh();
    });
  }
  function reset() {
    if (!confirm("Réinitialiser les données de démonstration ?")) return;
    startTransition(async () => {
      const res = await resetDemoAction();
      if (!res.ok) toast.error(res.error);
      else toast.success("Démo réinitialisée");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identité et domaine technique</CardTitle>
          <CardDescription>
            Le domaine technique (chez Gandi) porte l'outil (deploy.…) et les préproductions
            (client.preview.…). Le domaine principal de l'agence n'est jamais modifié.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            id="agencyName"
            label="Nom de l'agence"
            value={values.agencyName}
            onChange={set("agencyName")}
          />
          <Field
            id="alertEmail"
            label="Email des alertes"
            type="email"
            value={values.alertEmail}
            onChange={set("alertEmail")}
            placeholder="contact@auscii.com"
            hint="Reçoit les alertes : domaine qui expire, HTTPS en échec, déploiement en erreur."
          />
          <Field
            id="techDomain"
            label="Domaine technique"
            value={values.techDomain}
            onChange={set("techDomain")}
            hint={`Préproductions : client.${values.previewSubdomain}.${values.techDomain}`}
          />
          <Field
            id="previewSubdomain"
            label="Sous-domaine de préproduction"
            value={values.previewSubdomain}
            onChange={set("previewSubdomain")}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Serveurs et registrar</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            id="defaultOffer"
            label="Offre Scaleway par défaut"
            value={values.defaultOffer}
            onChange={set("defaultOffer")}
            hint="DEV1-S : 2 vCPU, 2 Go, 20 Go NVMe"
          />
          <Field
            id="defaultZone"
            label="Zone"
            value={values.defaultZone}
            onChange={set("defaultZone")}
          />
          <Field
            id="gandiOrganizationId"
            label="Organisation Gandi (sharing_id)"
            value={values.gandiOrganizationId}
            onChange={set("gandiOrganizationId")}
            hint="Propriétaire des domaines achetés"
          />
          <Field
            id="gandiEmail"
            label="Email de contact Gandi"
            type="email"
            value={values.gandiEmail}
            onChange={set("gandiEmail")}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Propriétaire des domaines (contact Gandi)</CardTitle>
          <CardDescription>
            L'agence est le propriétaire légal des domaines achetés. Ces coordonnées sont transmises
            à Gandi à chaque achat ; tous les champs sont obligatoires pour acheter.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            id="gandiOrgName"
            label="Raison sociale"
            value={values.gandiOrgName}
            onChange={set("gandiOrgName")}
          />
          <Field
            id="gandiPhone"
            label="Téléphone"
            placeholder="+33.612345678"
            value={values.gandiPhone}
            onChange={set("gandiPhone")}
            hint="Format international avec un point après l'indicatif"
          />
          <Field
            id="gandiGivenName"
            label="Prénom du contact"
            value={values.gandiGivenName}
            onChange={set("gandiGivenName")}
          />
          <Field
            id="gandiFamilyName"
            label="Nom du contact"
            value={values.gandiFamilyName}
            onChange={set("gandiFamilyName")}
          />
          <Field
            id="gandiStreet"
            label="Adresse"
            value={values.gandiStreet}
            onChange={set("gandiStreet")}
          />
          <Field
            id="gandiZip"
            label="Code postal"
            value={values.gandiZip}
            onChange={set("gandiZip")}
          />
          <Field
            id="gandiCity"
            label="Ville"
            value={values.gandiCity}
            onChange={set("gandiCity")}
          />
          <Field
            id="gandiCountry"
            label="Pays (code à 2 lettres)"
            value={values.gandiCountry}
            onChange={set("gandiCountry")}
            maxLength={2}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Capacité des serveurs</CardTitle>
          <CardDescription>
            Un serveur n'accueille plus de nouveau site au-delà de ces seuils ; un nouveau serveur
            est alors proposé. Le seuil d'alerte signale les serveurs qui approchent de la limite.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            id="diskUsedPctMax"
            label="Disque max (%)"
            type="number"
            value={values.diskUsedPctMax}
            onChange={set("diskUsedPctMax")}
          />
          <Field
            id="ramUsedPctMax"
            label="Mémoire max (%)"
            type="number"
            value={values.ramUsedPctMax}
            onChange={set("ramUsedPctMax")}
          />
          <Field
            id="loadPerVcpuMax"
            label="Charge max par vCPU"
            type="number"
            step="0.1"
            value={values.loadPerVcpuMax}
            onChange={set("loadPerVcpuMax")}
          />
          <Field
            id="sitesHardCap"
            label="Plafond de sites par serveur"
            type="number"
            value={values.sitesHardCap}
            onChange={set("sitesHardCap")}
          />
          <Field
            id="warnPct"
            label="Seuil d'alerte (% du max)"
            type="number"
            value={values.warnPct}
            onChange={set("warnPct")}
          />
        </CardContent>
      </Card>
      <div className="flex items-center justify-between">
        {settings.demoMode ? (
          <Button variant="outline" onClick={reset} disabled={pending}>
            <RotateCcwIcon /> Réinitialiser la démo
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          {demoForced && (
            <span className="text-muted-foreground text-xs">
              Mode démo forcé par DEMO_MODE=true
            </span>
          )}
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />} Enregistrer
          </Button>
        </div>
      </div>
    </div>
  );
}
