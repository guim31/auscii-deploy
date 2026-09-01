import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { env } from "@/server/env";
import { PageHeader } from "@/components/app/page-header";
import { AgencyForm } from "@/components/settings/agency-form";

export const dynamic = "force-dynamic";

export default async function AgencyPage() {
  await requireAdmin();
  const settings = await getSettings();
  return (
    <>
      <PageHeader
        title="Agence"
        description="Domaine technique, offre serveur par défaut, contact Gandi et seuils de capacité."
      />
      <AgencyForm settings={settings} demoForced={env().DEMO_MODE} />
    </>
  );
}
