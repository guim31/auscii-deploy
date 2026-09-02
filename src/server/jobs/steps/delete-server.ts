import { prisma } from "../../db";
import { getProviders } from "../../providers";
import { enqueue, QUEUES } from "../boss";

export type ServerDeletePayload = { serverId: string };

/** Queues the deletion of an empty server at the cloud provider (or simply retires a manual one). */
export async function requestServerDeletion(serverId: string): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const sites = await prisma.site.count({
    where: { serverId, status: { notIn: ["draft", "error"] } },
  });
  if (sites > 0) throw new Error("Ce serveur héberge encore des sites");
  if (server.provider === "manual" || !server.providerId) {
    await prisma.server.update({ where: { id: serverId }, data: { status: "retired" } });
    return;
  }
  await prisma.server.update({ where: { id: serverId }, data: { status: "retiring" } });
  await enqueue(QUEUES.serverDelete, { serverId } satisfies ServerDeletePayload, {
    singletonKey: `delete:${serverId}:${Date.now()}`,
  });
}

export async function runServerDelete({ serverId }: ServerDeletePayload): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server || server.status === "retired" || !server.providerId) return;
  const providers = await getProviders();
  try {
    await providers.cloud.deleteServer(
      server.providerId,
      server.zone,
      (server.providerData as Record<string, unknown> | null) ?? undefined,
    );
    await prisma.server.update({
      where: { id: serverId },
      data: {
        status: "retired",
        ip: null,
        metrics: { ...((server.metrics as object) ?? {}), deletedAt: new Date().toISOString() },
      },
    });
    console.log(`[server.delete] ${server.name} supprimé chez ${providers.cloud.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server.delete]", server.name, message);
    await prisma.server.update({
      where: { id: serverId },
      data: {
        status: "error",
        metrics: {
          ...((server.metrics as object) ?? {}),
          lastError: `Suppression échouée : ${message}`,
        },
      },
    });
  }
}
