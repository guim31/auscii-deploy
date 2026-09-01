import { requireUser } from "@/server/session";
import { getSettings } from "@/server/settings";
import { env } from "@/server/env";
import { AppShell } from "@/components/app/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const settings = await getSettings();
  return (
    <AppShell user={user} demoMode={settings.demoMode} demoForced={env().DEMO_MODE}>
      {children}
    </AppShell>
  );
}
