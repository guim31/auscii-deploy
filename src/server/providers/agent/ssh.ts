import { Readable } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import * as tar from "tar";
import { prisma } from "../../db";
import { fingerprintOf } from "../../deploy/ssh-keys";
import { checkTlsHost } from "../../deploy/tls";
import { READY_MARKER } from "../../deploy/bootstrap";
import type { ServerAgent, ServerMetrics, ServerRef, TlsCheck } from "../types";
import { ProviderNotConfiguredError } from "../types";
import { METRICS_COMMAND, parseMetrics } from "./metrics";

export type SshCredentials = { privateKey: string; publicKey: string };

export type ExecResult = { code: number; stdout: string; stderr: string };

const SITES_ROOT = "/srv/sites";
const CADDY_SITES = "/etc/caddy/sites";
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_LOG = 4000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug))
    throw new Error(`Identifiant de site invalide : ${slug}`);
  return slug;
}

function assertReleaseName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name))
    throw new Error(`Nom de release invalide : ${name}`);
  return name;
}

/**
 * Real SSH agent, built on ssh2. One connection per operation keeps the code
 * simple and robust; deployments run a handful of commands, not thousands.
 * The server's host key is remembered on first contact and checked afterwards.
 */
export class SshServerAgent implements ServerAgent {
  readonly name = "ssh";
  constructor(private readonly creds: SshCredentials | null) {}

  private async connect(server: ServerRef): Promise<Client> {
    if (!this.creds?.privateKey)
      throw new ProviderNotConfiguredError(
        "SSH",
        "Clé SSH du pilote absente (Paramètres > Intégrations > SSH).",
      );
    if (!server.ip) throw new Error(`Le serveur ${server.name} n'a pas d'adresse IP`);
    const row = await prisma.server.findUnique({
      where: { id: server.id },
      select: { sshPort: true, sshHostKey: true },
    });
    const port = row?.sshPort ?? 22;
    const known = row?.sshHostKey ?? null;
    let seen: string | null = null;

    const config: ConnectConfig = {
      host: server.ip,
      port,
      username: server.sshUser,
      privateKey: this.creds.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 10_000,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return known === null || known === seen;
      },
    };

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", (err: Error & { level?: string }) => {
        if (known && seen && known !== seen) {
          reject(
            new Error(
              `La clé d'hôte de ${server.name} a changé (${seen}). Si le serveur a été réinstallé, retirez-le et ajoutez-le à nouveau.`,
            ),
          );
        } else if (err.level === "client-timeout") {
          reject(new Error(`Connexion SSH à ${server.ip}:${port} impossible : délai dépassé`));
        } else {
          reject(new Error(`Connexion SSH à ${server.ip}:${port} refusée : ${err.message}`));
        }
      });
      client.connect(config);
    });
    if (!known && seen)
      await prisma.server.update({ where: { id: server.id }, data: { sshHostKey: seen } });
    return client;
  }

  private async withConnection<T>(
    server: ServerRef,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect(server);
    try {
      return await fn(client);
    } finally {
      client.end();
    }
  }

  private run(client: Client, command: string, stdin?: NodeJS.ReadableStream): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        stream.on("close", (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
        stream.on("error", reject);
        if (stdin) {
          stdin.on("error", reject);
          stdin.pipe(stream);
        }
      });
    });
  }

  private async must(
    client: Client,
    command: string,
    what: string,
    stdin?: NodeJS.ReadableStream,
  ): Promise<ExecResult> {
    const res = await this.run(client, command, stdin);
    if (res.code !== 0)
      throw new Error(
        `${what} : ${(res.stderr || res.stdout).trim().slice(0, MAX_LOG) || `code ${res.code}`}`,
      );
    return res;
  }

  async waitReady(server: ServerRef, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const res = await this.withConnection(server, (c) =>
          this.run(c, `test -f ${READY_MARKER} && caddy version`),
        );
        if (res.code === 0) return;
        lastError = `installation en cours (${READY_MARKER} absent)`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    throw new Error(`Le serveur ${server.name} n'est pas prêt : ${lastError}`);
  }

  exec(server: ServerRef, command: string): Promise<ExecResult> {
    return this.withConnection(server, (c) => this.run(c, command));
  }

  async ensureSiteDirs(server: ServerRef, slug: string): Promise<void> {
    const dir = `${SITES_ROOT}/${assertSlug(slug)}`;
    await this.withConnection(server, (c) =>
      this.must(c, `mkdir -p ${shellQuote(`${dir}/releases`)}`, "Création des dossiers"),
    );
  }

  async uploadRelease(
    server: ServerRef,
    slug: string,
    releaseDir: string,
    releaseName: string,
  ): Promise<void> {
    const target = `${SITES_ROOT}/${assertSlug(slug)}/releases/${assertReleaseName(releaseName)}`;
    const archive = Readable.from(
      tar.create({ gzip: true, cwd: releaseDir, portable: true }, ["."]),
    );
    await this.withConnection(server, (c) =>
      this.must(
        c,
        `rm -rf ${shellQuote(target)} && mkdir -p ${shellQuote(target)} && tar xzf - -C ${shellQuote(target)}`,
        "Envoi de la release",
        archive,
      ),
    );
  }

  async switchRelease(server: ServerRef, slug: string, releaseName: string): Promise<void> {
    const dir = `${SITES_ROOT}/${assertSlug(slug)}`;
    const rel = `releases/${assertReleaseName(releaseName)}`;
    await this.withConnection(server, (c) =>
      this.must(
        c,
        `test -d ${shellQuote(`${dir}/${rel}`)} && ln -sfn ${shellQuote(rel)} ${shellQuote(`${dir}/current.tmp`)} && mv -Tf ${shellQuote(`${dir}/current.tmp`)} ${shellQuote(`${dir}/current`)}`,
        "Bascule de la release",
      ),
    );
  }

  async writeCaddySite(server: ServerRef, slug: string, config: string): Promise<void> {
    const file = `${CADDY_SITES}/${assertSlug(slug)}.caddy`;
    await this.withConnection(server, async (c) => {
      await this.must(
        c,
        `cat > ${shellQuote(file)}`,
        "Écriture de la configuration Caddy",
        stringStream(config),
      );
      const check = await this.run(
        c,
        "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1",
      );
      if (check.code !== 0) {
        await this.run(c, `rm -f ${shellQuote(file)}`);
        throw new Error(
          `Configuration Caddy refusée : ${(check.stdout || check.stderr).trim().slice(0, MAX_LOG)}`,
        );
      }
    });
  }

  async removeCaddySite(server: ServerRef, slug: string): Promise<void> {
    const file = `${CADDY_SITES}/${assertSlug(slug)}.caddy`;
    await this.withConnection(server, (c) =>
      this.must(c, `rm -f ${shellQuote(file)}`, "Suppression de la configuration Caddy"),
    );
  }

  async reloadCaddy(server: ServerRef): Promise<void> {
    await this.withConnection(server, (c) =>
      this.must(c, "sudo -n /usr/bin/systemctl reload caddy", "Rechargement de Caddy"),
    );
  }

  async collectMetrics(server: ServerRef): Promise<ServerMetrics> {
    const res = await this.withConnection(server, (c) =>
      this.must(c, METRICS_COMMAND, "Relevé des métriques"),
    );
    return parseMetrics(res.stdout, server.vcpus);
  }

  checkTls(host: string): Promise<TlsCheck> {
    return checkTlsHost(host);
  }
}

function stringStream(content: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(content, "utf8")]);
}
