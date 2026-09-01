"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { n: 1, label: "Domaine" },
  { n: 2, label: "Provisioning" },
  { n: 3, label: "Site" },
  { n: 4, label: "Mise en ligne" },
];

export function Stepper({ siteId, reachable }: { siteId: string; reachable: number }) {
  const pathname = usePathname();
  const current = Number(pathname.match(/step-(\d)/)?.[1] ?? 1);
  return (
    <ol className="mb-8 flex items-center gap-2 text-sm">
      {STEPS.map((step, i) => {
        const done = step.n < current;
        const active = step.n === current;
        const canGo = step.n <= reachable;
        const inner = (
          <span
            className={cn(
              "flex items-center gap-2",
              active
                ? "text-foreground font-semibold"
                : done
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : done
                    ? "border-success bg-success/15 text-success"
                    : "border-border",
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : step.n}
            </span>
            {step.label}
          </span>
        );
        return (
          <li key={step.n} className="flex items-center gap-2">
            {canGo && !active ? (
              <Link href={`/deploy/${siteId}/step-${step.n}`}>{inner}</Link>
            ) : (
              inner
            )}
            {i < STEPS.length - 1 && <span className="bg-border mx-1 h-px w-8" />}
          </li>
        );
      })}
    </ol>
  );
}
