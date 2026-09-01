import { requireAdmin } from "@/server/session";
import { prisma } from "@/server/db";
import { PageHeader } from "@/components/app/page-header";
import { IntegrationsForm, type IntegrationState } from "@/components/settings/integrations-form";
import { INTEGRATIONS } from "@/server/providers";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requireAdmin();
  const rows = await prisma.integration.findMany();
  const state: IntegrationState[] = INTEGRATIONS.map((name) => {
    const row = rows.find((r) => r.provider === name);
    return {
      name,
      configured: Boolean(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
      lastTestAt: row?.lastTestAt?.toISOString() ?? null,
      lastTestOk: row?.lastTestOk ?? null,
    };
  });
  return (
    <>
      <PageHeader
        title="Intégrations"
        description="Les clés sont chiffrées en base et ne sont jamais renvoyées au navigateur. Laissez un formulaire vide pour supprimer une clé."
      />
      <IntegrationsForm state={state} />
    </>
  );
}
