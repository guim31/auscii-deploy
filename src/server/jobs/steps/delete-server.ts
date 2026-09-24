import { prisma } from "../../db";
import { getProviders } from "../../providers";
import { enqueue, QUEUES } from "../boss";
import { redactSecrets } from "../log";

export type ServerDeletePayload = { serverId: string };

/**
 * Queues the deletion of an empty server at the cloud provider (or simply
 * retires a manual one). The server is first taken out of placement
 * ("retiring"), then checked for sites: nothing can be placed on it meanwhile.
 */
export async function requestServerDeletion(serverId: string): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  if (server.status === "ordering" || server.status === "bootstrapping")
    throw new Error(
      "Ce serveur est en cours d'installation : attendez la fin avant de le supprimer.",
    );
  const locked = await prisma.server.updateMany({
    where: { id: serverId, status: { in: ["ready", "error"] } },
    data: { status: "retiring" },
  });
  if (locked.count === 0) throw new Error("Ce serveur est déjà en cours de suppression.");
  // Any site other than a draft, or that was ever published, keeps its server.
  const sites = await prisma.site.count({
    where: {
      serverId,
      OR: [{ status: { not: "draft" } }, { liveReleaseId: { not: null } }],
    },
  });
  if (sites > 0) {
    await prisma.server.update({ where: { id: serverId }, data: { status: server.status } });
    throw new Error("Ce serveur héberge encore des sites");
  }
  if (server.provider === "manual") {
    await prisma.server.update({ where: { id: serverId }, data: { status: "retired" } });
    return;
  }
  await enqueue(QUEUES.serverDelete, { serverId } satisfies ServerDeletePayload, {
    singletonKey: `delete:${serverId}:${Date.now()}`,
  });
}

export async function runServerDelete({ serverId }: ServerDeletePayload): Promise<void> {
  let server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server || server.status === "retired") return;
  const providers = await getProviders({ demo: server.isDemo });
  try {
    if (!server.providerId) {
      // An order interrupted before its id was saved: look the instance up by name.
      const found = await providers.cloud.findServerByName(server.name, server.zone);
      if (found)
        server = await prisma.server.update({
          where: { id: serverId },
          data: {
            providerId: found.providerId,
            providerData: (found.metadata as object | undefined) ?? undefined,
          },
        });
    }
    if (server.providerId)
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
        lastError: null,
        metrics: { ...((server.metrics as object) ?? {}), deletedAt: new Date().toISOString() },
      },
    });
    console.log(`[server.delete] ${server.name} supprimé chez ${providers.cloud.name}`);
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    console.error("[server.delete]", server.name, message);
    await prisma.server.update({
      where: { id: serverId },
      data: { status: "error", lastError: `Suppression échouée : ${message}` },
    });
  }
}
