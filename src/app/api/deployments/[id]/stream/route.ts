import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";

export const dynamic = "force-dynamic";

const POLL_MS = 700;
const HEARTBEAT_MS = 15_000;
/** The browser reconnects by itself (with Last-Event-ID) once a stream ends. */
const MAX_STREAM_MS = 10 * 60_000;
const RETRY_MS = 2_000;

/** Waits, or returns early when the client goes away. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

function logCursor(value: string | null): number {
  if (!value || !/^\d{1,15}$/.test(value.trim())) return 0;
  return Number(value.trim());
}

/**
 * Server-sent events: deployment logs and step states, polled from the
 * database. Events: `log` (with the log id as SSE id, so a reconnection
 * resumes after the last line received), `state` when it changes, and
 * `failure` ({ message, final }): final means the client must stop.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { id } = await ctx.params;
  const exists = await prisma.deployment.findUnique({ where: { id }, select: { id: true } });
  // A non-200 answer makes EventSource give up instead of reconnecting forever.
  if (!exists) return Response.json({ error: "Déploiement introuvable" }, { status: 404 });

  const encoder = new TextEncoder();
  let lastLogId = Math.max(
    logCursor(new URL(request.url).searchParams.get("after")),
    logCursor(request.headers.get("last-event-id")),
  );
  let closed = false;
  const signal = request.signal;
  signal.addEventListener("abort", () => {
    closed = true;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown, eventId?: number) =>
        write(
          `${eventId !== undefined ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );

      write(`retry: ${RETRY_MS}\n\n`);
      const startedAt = Date.now();
      let lastState = "";
      let lastBeat = Date.now();
      try {
        while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
          const deployment = await prisma.deployment.findUnique({ where: { id } });
          if (!deployment) {
            send("failure", { message: "Déploiement introuvable", final: true });
            break;
          }
          const logs = await prisma.deploymentLog.findMany({
            where: { deploymentId: id, id: { gt: lastLogId } },
            orderBy: { id: "asc" },
            take: 200,
          });
          for (const log of logs) {
            send(
              "log",
              { id: log.id, ts: log.ts, level: log.level, step: log.step, message: log.message },
              log.id,
            );
            lastLogId = log.id;
          }
          const state = JSON.stringify({
            status: deployment.status,
            steps: deployment.steps,
            error: deployment.error,
          });
          if (state !== lastState) {
            write(`event: state\ndata: ${state}\n\n`);
            lastState = state;
            lastBeat = Date.now();
          } else if (Date.now() - lastBeat > HEARTBEAT_MS) {
            write(": ping\n\n");
            lastBeat = Date.now();
          }
          const finished = deployment.status === "succeeded" || deployment.status === "failed";
          // Logs written just before the end may still be arriving: one last pass.
          if (finished && logs.length < 200) break;
          await sleep(POLL_MS, signal);
        }
      } catch (err) {
        console.error("[deploy.stream]", id, err instanceof Error ? err.message : err);
        // Transient (database): the browser reconnects and resumes after the last id.
        send("failure", { message: "Journal momentanément indisponible", final: false });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
