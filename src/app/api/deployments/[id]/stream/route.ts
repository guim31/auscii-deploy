import { prisma } from "@/server/db";
import { apiUser, isResponse } from "@/server/api-auth";

export const dynamic = "force-dynamic";

/** Server-sent events: deployment logs and step states, polled from the database. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (isResponse(user)) return user;
  const { id } = await ctx.params;
  const encoder = new TextEncoder();
  let lastLogId = Number(new URL(request.url).searchParams.get("after") ?? 0);
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const tick = async (): Promise<boolean> => {
        const deployment = await prisma.deployment.findUnique({ where: { id } });
        if (!deployment) {
          send("error", { message: "Déploiement introuvable" });
          return true;
        }
        const logs = await prisma.deploymentLog.findMany({
          where: { deploymentId: id, id: { gt: lastLogId } },
          orderBy: { id: "asc" },
          take: 200,
        });
        for (const log of logs) {
          send("log", {
            id: log.id,
            ts: log.ts,
            level: log.level,
            step: log.step,
            message: log.message,
          });
          lastLogId = log.id;
        }
        send("state", {
          status: deployment.status,
          steps: deployment.steps,
          error: deployment.error,
        });
        return deployment.status === "succeeded" || deployment.status === "failed";
      };
      try {
        while (!closed) {
          const done = await tick();
          if (done) break;
          await new Promise((r) => setTimeout(r, 700));
        }
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
