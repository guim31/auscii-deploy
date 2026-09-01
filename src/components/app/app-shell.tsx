"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { GlobeIcon, LogOutIcon, ServerIcon, SettingsIcon, FlaskConicalIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toggleDemoAction } from "@/server/actions/settings";
import type { CurrentUser } from "@/server/session";

const NAV = [
  { href: "/", label: "Sites", icon: GlobeIcon },
  { href: "/settings/servers", label: "Serveurs", icon: ServerIcon },
  { href: "/settings/integrations", label: "Paramètres", icon: SettingsIcon, admin: true },
];

export function AppShell({
  user,
  demoMode,
  demoForced,
  children,
}: {
  user: CurrentUser;
  demoMode: boolean;
  demoForced: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onToggleDemo(on: boolean) {
    startTransition(async () => {
      const res = await toggleDemoAction(on);
      if (res.error) toast.error(res.error);
      else toast.success(on ? "Mode démo activé" : "Mode démo désactivé");
      router.refresh();
    });
  }

  async function logout() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-background/95 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md text-sm font-bold">
              A
            </span>
            auscii-deploy
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.filter((n) => !n.admin || user.role === "admin").map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/" ||
                    pathname.startsWith("/sites") ||
                    pathname.startsWith("/deploy")
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            {demoMode && (
              <Badge variant="warning" className="gap-1">
                <FlaskConicalIcon />
                Mode démo
              </Badge>
            )}
            {user.role === "admin" && (
              <label
                className="text-muted-foreground flex items-center gap-2 text-sm"
                title={
                  demoForced
                    ? "Forcé par DEMO_MODE=true dans la configuration"
                    : "Bascule sur les intégrations simulées"
                }
              >
                <Switch
                  checked={demoMode}
                  disabled={demoForced || pending}
                  onCheckedChange={onToggleDemo}
                  aria-label="Mode démo"
                />
                Démo
              </label>
            )}
            <span className="text-muted-foreground hidden text-sm sm:inline">{user.name}</span>
            <Button variant="ghost" size="icon" onClick={logout} title="Se déconnecter">
              <LogOutIcon />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
