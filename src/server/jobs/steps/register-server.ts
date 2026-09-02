import { prisma } from "../../db";
import { getProviders } from "../../providers";
import { enqueue, QUEUES } from "../boss";
import type { Logger } from "../log";
import { bootstrapServer } from "./server";

export type ServerBootstrapPayload = { serverId: string };

export type ExistingServerInput = {
  name: string;
  ip: string;
  sshPort: number;
  sshUser: string;
  vcpus: number;
  offer: string;
  zone: string;
};

/** Registers a server installed by hand (bootstrap-server.sh) and queues its readiness check. */
export async function registerExistingServer(input: ExistingServerInput) {
  const providers = await getProviders();
  const server = await prisma.server.create({
    data: {
      name: input.name,
      provider: providers.demo ? "mock" : "manual",
      ip: input.ip,
      sshPort: input.sshPort,
      sshUser: input.sshUser,
      vcpus: input.vcpus,
      offer: input.offer,
      zone: input.zone,
      status: "bootstrapping",
      isDemo: providers.demo,
    },
  });
  await enqueue(QUEUES.serverBootstrap, { serverId: server.id } satisfies ServerBootstrapPayload, {
    singletonKey: `bootstrap:${server.id}:${Date.now()}`,
  });
  return server;
}

/** Re-runs the readiness check of a server in error, keeping its host key unless asked otherwise. */
export async function retestServer(serverId: string, forgetHostKey = false) {
  await prisma.server.update({
    where: { id: serverId },
    data: { status: "bootstrapping", ...(forgetHostKey ? { sshHostKey: null } : {}) },
  });
  await enqueue(QUEUES.serverBootstrap, { serverId } satisfies ServerBootstrapPayload, {
    singletonKey: `bootstrap:${serverId}:${Date.now()}`,
  });
}

const consoleLogger: Logger = {
  info: async (m) => console.log("[server.bootstrap]", m),
  success: async (m) => console.log("[server.bootstrap]", m),
  warn: async (m) => console.warn("[server.bootstrap]", m),
  error: async (m) => console.error("[server.bootstrap]", m),
};

export async function runServerBootstrap({ serverId }: ServerBootstrapPayload): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server || server.status === "retired") return;
  const providers = await getProviders();
  try {
    await bootstrapServer({ ...server, status: "bootstrapping" }, providers, consoleLogger);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server.bootstrap]", server.name, message);
    await prisma.server.update({
      where: { id: serverId },
      data: {
        status: "error",
        metrics: {
          ...((server.metrics as object) ?? {}),
          lastError: message,
          collectedAt: new Date().toISOString(),
        },
      },
    });
  }
}
