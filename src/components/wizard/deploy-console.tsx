"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2Icon,
  CircleIcon,
  Loader2Icon,
  XCircleIcon,
  MinusCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepState } from "@/server/jobs/pipeline";

export type ConsoleLog = {
  id: number;
  ts: string;
  level: "info" | "success" | "warn" | "error";
  step: string | null;
  message: string;
};
export type ConsoleState = {
  status: "queued" | "running" | "succeeded" | "failed";
  steps: StepState[];
  error: string | null;
};

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "done") return <CheckCircle2Icon className="text-success size-4" />;
  if (status === "skipped") return <MinusCircleIcon className="text-muted-foreground size-4" />;
  if (status === "failed") return <XCircleIcon className="text-destructive size-4" />;
  if (status === "running") return <Loader2Icon className="text-primary size-4 animate-spin" />;
  return <CircleIcon className="text-muted-foreground/50 size-4" />;
}

const LEVEL: Record<ConsoleLog["level"], string> = {
  info: "text-slate-300",
  success: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

/** Live view of a deployment: step list plus streamed logs over SSE. */
export function DeployConsole({
  deploymentId,
  initialState,
  initialLogs = [],
  onFinished,
  compact = false,
}: {
  deploymentId: string;
  initialState: ConsoleState;
  initialLogs?: ConsoleLog[];
  onFinished?: (status: "succeeded" | "failed") => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<ConsoleState>(initialState);
  const [logs, setLogs] = useState<ConsoleLog[]>(initialLogs);
  const bottomRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (initialState.status === "succeeded" || initialState.status === "failed") return;
    const after = initialLogs.length ? initialLogs[initialLogs.length - 1].id : 0;
    const es = new EventSource(`/api/deployments/${deploymentId}/stream?after=${after}`);
    es.addEventListener("log", (e) =>
      setLogs((prev) => [...prev, JSON.parse((e as MessageEvent).data) as ConsoleLog]),
    );
    es.addEventListener("state", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as ConsoleState;
      setState(next);
      if ((next.status === "succeeded" || next.status === "failed") && !finishedRef.current) {
        finishedRef.current = true;
        es.close();
        onFinished?.(next.status);
      }
    });
    es.addEventListener("error", () => {
      /* the browser reconnects; a closed finished stream is expected */
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [logs.length]);

  return (
    <div className={cn("grid gap-4", compact ? "" : "md:grid-cols-[260px_1fr]")}>
      <ol className={cn("flex gap-2", compact ? "flex-row flex-wrap" : "flex-col")}>
        {state.steps.map((step) => (
          <li
            key={step.key}
            className={cn(
              "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm",
              step.status === "running" && "bg-accent",
            )}
          >
            <span className="mt-0.5">
              <StepIcon status={step.status} />
            </span>
            <div>
              <div className={cn(step.status === "pending" && "text-muted-foreground")}>
                {step.label}
              </div>
              {step.detail && step.status !== "failed" && (
                <div className="text-muted-foreground text-xs">{step.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div
        className="flex min-h-48 flex-col overflow-hidden rounded-lg bg-slate-950 font-mono text-xs"
        data-testid="deploy-console"
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-slate-400">
          <span className="size-2 rounded-full bg-red-500/80" />
          <span className="size-2 rounded-full bg-amber-500/80" />
          <span className="size-2 rounded-full bg-emerald-500/80" />
          <span className="ml-2">journal du déploiement</span>
          <span className="ml-auto uppercase">
            {state.status === "running"
              ? "en cours"
              : state.status === "succeeded"
                ? "terminé"
                : state.status === "failed"
                  ? "échoué"
                  : "en attente"}
          </span>
        </div>
        <div className="max-h-80 flex-1 overflow-y-auto p-3">
          {logs.length === 0 && <div className="text-slate-500">En attente du worker…</div>}
          {logs.map((log) => (
            <div key={log.id} className={cn("whitespace-pre-wrap", LEVEL[log.level])}>
              <span className="text-slate-600">
                {new Date(log.ts).toLocaleTimeString("fr-FR")}{" "}
              </span>
              {log.step && <span className="text-slate-500">[{log.step}] </span>}
              {log.message}
            </div>
          ))}
          {state.error && state.status === "failed" && (
            <div className="mt-2 text-red-300">✖ {state.error}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
