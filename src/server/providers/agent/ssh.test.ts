/**
 * SshServerAgent against an in-process ssh2 server: host key trust on first
 * use, command timeout, and a dropped connection that must not crash the
 * worker (a second "error" event used to be unhandled).
 */
import type { AddressInfo } from "node:net";
import { Server, type Connection, type ServerChannel } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../db";
import { generateSshKeyPair } from "../../deploy/ssh-keys";
import type { ServerRef } from "../types";
import { SshServerAgent } from "./ssh";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("SshServerAgent transport", () => {
  const hostKey = generateSshKeyPair("test-host");
  const clientKey = generateSshKeyPair("test-client");
  const connections = new Set<Connection>();
  let sshd: Server;
  let port: number;
  let server: ServerRef;

  function handle(command: string, channel: ServerChannel, conn: Connection) {
    if (command === "echo hi") {
      channel.write("hi\n");
      channel.exit(0);
      channel.end();
    } else if (command === "hang") {
      // Never answers.
    } else if (command === "drop") {
      // Kills the TCP connection in the middle of the command.
      (conn as unknown as { _sock: { destroy(): void } })._sock.destroy();
    } else {
      channel.stderr.write("unknown\n");
      channel.exit(127);
      channel.end();
    }
  }

  beforeAll(async () => {
    sshd = new Server({ hostKeys: [hostKey.privateKey] }, (conn) => {
      connections.add(conn);
      conn.on("error", () => undefined);
      conn.on("authentication", (ctx) => ctx.accept());
      conn.on("ready", () => {
        conn.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            handle(info.command, acceptExec(), conn);
          });
        });
      });
    });
    await new Promise<void>((r) => sshd.listen(0, "127.0.0.1", () => r()));
    port = (sshd.address() as AddressInfo).port;
    const row = await prisma.server.create({
      data: {
        name: `ssh-unit-${Date.now()}`,
        provider: "manual",
        ip: "127.0.0.1",
        sshPort: port,
        status: "ready",
        offer: "test",
      },
    });
    server = { id: row.id, name: row.name, ip: row.ip, sshUser: "deploy", vcpus: 1 };
  });

  afterAll(async () => {
    await prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
    for (const c of connections) c.end();
    await new Promise<void>((r) => sshd.close(() => r()));
  });

  it("trusts the host key on first contact, visibly, then enforces it", async () => {
    const trusted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agent = new SshServerAgent(clientKey, { onHostKeyTrusted: trusted });
    const res = await agent.exec(server, "echo hi");
    expect(res).toMatchObject({ code: 0, stdout: "hi\n" });
    expect(trusted).toHaveBeenCalledWith(server, hostKey.fingerprint);
    expect(warn.mock.calls.flat().join(" ")).toContain(hostKey.fingerprint);
    const row = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
    expect(row.sshHostKey).toBe(hostKey.fingerprint);

    // Second contact: already known, no new trust event.
    trusted.mockClear();
    await agent.exec(server, "echo hi");
    expect(trusted).not.toHaveBeenCalled();

    // A different key is refused.
    await prisma.server.update({
      where: { id: server.id },
      data: { sshHostKey: "SHA256:someoneelse" },
    });
    await expect(agent.exec(server, "echo hi")).rejects.toThrow(/clé d'hôte .* a changé/);
    await prisma.server.update({
      where: { id: server.id },
      data: { sshHostKey: hostKey.fingerprint },
    });
    warn.mockRestore();
  });

  it("gives up on a command that exceeds its timeout", async () => {
    const agent = new SshServerAgent(clientKey, { commandTimeoutMs: 300 });
    await expect(agent.exec(server, "hang")).rejects.toThrow(/interrompue après/);
  });

  it("fails the command, without crashing, when the connection drops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agent = new SshServerAgent(clientKey, { commandTimeoutMs: 5_000 });
    await expect(agent.exec(server, "drop")).rejects.toThrow(/interrompue/);
    // The agent still works afterwards.
    await expect(agent.exec(server, "echo hi")).resolves.toMatchObject({ code: 0 });
    warn.mockRestore();
  });
});
