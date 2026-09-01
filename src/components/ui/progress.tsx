import * as React from "react";
import { cn } from "@/lib/utils";

function Progress({
  value,
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"div"> & {
  value: number;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const width = Math.max(0, Math.min(100, value));
  const bar = {
    default: "bg-primary",
    success: "bg-success",
    warning: "bg-warning",
    destructive: "bg-destructive",
  }[tone];
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(width)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <div
        className={cn("h-full rounded-full transition-all", bar)}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export { Progress };
