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

function isFinished(status: ConsoleState["status"]): status is "succeeded" | "failed" {
  return status === "succeeded" || status === "failed";
}

function lastId(logs: ConsoleLog[]): number {
  return logs.length ? logs[logs.length - 1].id : 0;
}

/**
 * Live view of a deployment: step list plus streamed logs over SSE. When the
 * parent passes a running state again for the same deployment (after
 * "Réessayer" and a refresh), the console follows the new run.
 */
export function DeployConsole({
  deploymentId,
  initialState,
  initialLogs = [],
  onFinished,
  onStatusChange,
  compact = false,
}: {
  deploymentId: string;
  initialState: ConsoleState;
  initialLogs?: ConsoleLog[];
  onFinished?: (status: "succeeded" | "failed") => void;
  /** Every status change, e.g. to disable buttons while the deployment runs. */
  onStatusChange?: (status: ConsoleState["status"]) => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<ConsoleState>(initialState);
  const [logs, setLogs] = useState<ConsoleLog[]>(initialLogs);
  const [streamError, setStreamError] = useState<string | null>(null);
  // Bumped when a finished deployment is started again: reconnects the stream.
  const [generation, setGeneration] = useState(0);
  const [seenInitial, setSeenInitial] = useState(initialState);
  if (seenInitial !== initialState) {
    setSeenInitial(initialState);
    if (isFinished(state.status) && !isFinished(initialState.status)) {
      setState(initialState);
      setStreamError(null);
      setGeneration((g) => g + 1);
    }
  }

  const bottomRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(state.status);
  const cursorRef = useRef(lastId(initialLogs));
  const callbacks = useRef({ onFinished, onStatusChange });
  useEffect(() => {
    callbacks.current = { onFinished, onStatusChange };
  });

  useEffect(() => {
    statusRef.current = state.status;
    callbacks.current.onStatusChange?.(state.status);
  }, [state.status]);

  useEffect(() => {
    if (isFinished(statusRef.current)) return;
    let finished = false;
    const es = new EventSource(
      `/api/deployments/${deploymentId}/stream?after=${cursorRef.current}`,
    );
    es.addEventListener("log", (e) => {
      const log = JSON.parse((e as MessageEvent).data) as ConsoleLog;
      // The server resumes after Last-Event-ID; this guards against any replay.
      if (log.id <= cursorRef.current) return;
      cursorRef.current = log.id;
      setLogs((prev) => [...prev, log]);
    });
    es.addEventListener("state", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as ConsoleState;
      setState(next);
      setStreamError(null);
      if (isFinished(next.status) && !finished) {
        finished = true;
        es.close();
        callbacks.current.onFinished?.(next.status);
      }
    });
    es.addEventListener("failure", (e) => {
      const { message, final } = JSON.parse((e as MessageEvent).data) as {
        message: string;
        final: boolean;
      };
      setStreamError(message);
      if (final) es.close();
    });
    es.onerror = () => {
      // CLOSED: the server refused the stream (session expired, unknown deployment).
      if (es.readyState === EventSource.CLOSED && !finished)
        setStreamError("Suivi interrompu. Rechargez la page pour reprendre.");
    };
    return () => es.close();
  }, [deploymentId, generation]);

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
        <div className="max-h-80 flex-1 overflow-y-auto p-3" role="log" aria-live="polite">
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
          {streamError && !isFinished(state.status) && (
            <div className="mt-2 text-amber-300">{streamError}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
