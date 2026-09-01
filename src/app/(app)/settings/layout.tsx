import { requireUser } from "@/server/session";
import { SettingsNav } from "@/components/settings/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="grid gap-8 md:grid-cols-[200px_1fr]">
      <SettingsNav isAdmin={user.role === "admin"} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
