"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/settings/servers", label: "Serveurs" },
  { href: "/settings/integrations", label: "Intégrations", admin: true },
  { href: "/settings/agency", label: "Agence", admin: true },
  { href: "/settings/users", label: "Utilisateurs", admin: true },
];

export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 text-sm">
      <div className="text-muted-foreground mb-2 px-3 text-xs font-medium tracking-wide uppercase">
        Paramètres
      </div>
      {ITEMS.filter((i) => !i.admin || isAdmin).map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "rounded-md px-3 py-1.5",
            pathname.startsWith(item.href)
              ? "bg-accent font-medium"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
