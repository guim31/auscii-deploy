import { createHash } from "node:crypto";
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
import {
  DEFAULT_CADDY_PATHS,
  hasReleaseScript,
  pruneReleasesScript,
  reloadCaddyScript,
  removeCaddySiteScript,
  shellQuote,
  uploadReleaseScript,
  writeCaddySiteScript,
} from "./remote-scripts";

export type SshCredentials = { privateKey: string; publicKey: string };

export type ExecResult = { code: number; stdout: string; stderr: string };

export type SshAgentOptions = {
  /** Longest a single remote command may run (default 5 min). */
  commandTimeoutMs?: number;
  /** Longest a release upload may run (default 15 min). */
  uploadTimeoutMs?: number;
  /**
   * Called when a server's host key is trusted for the first time (TOFU), so
   * the caller can record it in a deployment log. Always logged on the console.
   */
  onHostKeyTrusted?: (server: ServerRef, fingerprint: string) => void | Promise<void>;
};

const SITES_ROOT = "/srv/sites";
const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_LOG = 4000;
/** Output kept in memory per command: metrics and logs are small, a runaway command is not. */
const MAX_OUTPUT = 1024 * 1024;
const RELOAD_COMMAND = "sudo -n /usr/bin/systemctl reload caddy";

export function assertSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug))
    throw new Error(`Identifiant de site invalide : ${slug}`);
  return slug;
}

export function assertReleaseName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name))
    throw new Error(`Nom de release invalide : ${name}`);
  return name;
}

function trimOutput(res: ExecResult): string {
  return (res.stderr || res.stdout).trim().slice(0, MAX_LOG) || `code ${res.code}`;
}

/**
 * Real SSH agent, built on ssh2. One connection per operation keeps the code
 * simple and robust; deployments run a handful of commands, not thousands.
 * The server's host key is remembered on first contact and checked afterwards.
 */
export class SshServerAgent implements ServerAgent {
  readonly name = "ssh";
  private readonly commandTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(
    private readonly creds: SshCredentials | null,
    private readonly options: SshAgentOptions = {},
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

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
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return known === null || known === seen;
      },
    };

    const client = new Client();
    let connected = false;
    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => {
        connected = true;
        resolve();
      });
      // Persistent listener: ssh2 may emit several errors (e.g. a reset after
      // a timeout). Without a listener, an "error" event crashes the worker.
      // Once connected, the commands in flight fail through the "close" event.
      client.on("error", (err: Error & { level?: string }) => {
        if (connected) {
          console.warn(`[ssh] ${server.name} : ${err.message}`);
          return;
        }
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
    if (!known && seen) {
      await prisma.server.update({ where: { id: server.id }, data: { sshHostKey: seen } });
      console.warn(
        `[ssh] Clé d'hôte de ${server.name} (${server.ip}:${port}) enregistrée au premier contact : ${seen}`,
      );
      await Promise.resolve(this.options.onHostKeyTrusted?.(server, seen)).catch(() => undefined);
    }
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

  /**
   * Runs one command. Rejects when it exceeds its timeout (the connection is
   * then torn down, which kills the remote command) or when the connection
   * drops before the command ends.
   */
  private run(
    client: Client,
    command: string,
    stdin?: NodeJS.ReadableStream,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off("close", onClientClose);
        fn();
      };
      const onClientClose = () =>
        finish(() => reject(new Error("Connexion SSH interrompue pendant la commande")));
      const timer = setTimeout(
        () =>
          finish(() => {
            client.end();
            client.destroy();
            reject(
              new Error(
                `Commande interrompue après ${Math.round(timeoutMs / 1000)} s sans réponse du serveur`,
              ),
            );
          }),
        timeoutMs,
      );
      client.on("close", onClientClose);

      client.exec(command, (err, stream: ClientChannel) => {
        if (err) return finish(() => reject(err));
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += d.toString();
        });
        stream.stderr.on("data", (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += d.toString();
        });
        stream.on("close", (code: number | null) =>
          finish(() => resolve({ code: code ?? -1, stdout, stderr })),
        );
        stream.on("error", (e: Error) => finish(() => reject(e)));
        if (stdin) {
          stdin.on("error", (e: Error) =>
            finish(() => {
              stream.close();
              reject(e);
            }),
          );
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
    timeoutMs?: number,
  ): Promise<ExecResult> {
    const res = await this.run(client, command, stdin, timeoutMs);
    if (res.code !== 0) throw new Error(`${what} : ${trimOutput(res)}`);
    return res;
  }

  async waitReady(server: ServerRef, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const res = await this.withConnection(server, (c) =>
          this.run(c, `test -f ${READY_MARKER} && caddy version`, undefined, 60_000),
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
    const releasesDir = `${SITES_ROOT}/${assertSlug(slug)}/releases`;
    const name = assertReleaseName(releaseName);
    await this.withConnection(server, async (c) => {
      // Immutable: nothing to send when the release is already complete.
      const present = await this.run(c, hasReleaseScript({ releasesDir, name }));
      if (present.code === 0) return;
      const archive = Readable.from(
        tar.create({ gzip: true, cwd: releaseDir, portable: true }, ["."]),
      );
      await this.must(
        c,
        `mkdir -p ${shellQuote(releasesDir)} && ${uploadReleaseScript({ releasesDir, name })}`,
        "Envoi de la release",
        archive,
        this.uploadTimeoutMs,
      );
    });
  }

  async hasRelease(server: ServerRef, slug: string, releaseName: string): Promise<boolean> {
    const releasesDir = `${SITES_ROOT}/${assertSlug(slug)}/releases`;
    const name = assertReleaseName(releaseName);
    const res = await this.withConnection(server, (c) =>
      this.run(c, hasReleaseScript({ releasesDir, name })),
    );
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw new Error(`Vérification de la release : ${trimOutput(res)}`);
  }

  async pruneReleases(server: ServerRef, slug: string, keep: string[]): Promise<string[]> {
    const siteDir = `${SITES_ROOT}/${assertSlug(slug)}`;
    const script = pruneReleasesScript({ siteDir, keep: keep.map(assertReleaseName) });
    const res = await this.withConnection(server, (c) =>
      this.must(c, script, "Purge des anciennes releases"),
    );
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("rel-"));
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
    const name = assertSlug(slug);
    const sha256 = createHash("sha256").update(config, "utf8").digest("hex");
    const res = await this.withConnection(server, (c) =>
      this.run(
        c,
        writeCaddySiteScript(DEFAULT_CADDY_PATHS, { name, sha256 }),
        stringStream(config),
      ),
    );
    if (res.code === 3) throw new Error(`Configuration Caddy refusée : ${trimOutput(res)}`);
    if (res.code !== 0) throw new Error(`Écriture de la configuration Caddy : ${trimOutput(res)}`);
  }

  async removeCaddySite(server: ServerRef, slug: string): Promise<void> {
    const name = assertSlug(slug);
    await this.withConnection(server, (c) =>
      this.must(
        c,
        removeCaddySiteScript(DEFAULT_CADDY_PATHS, { name }),
        "Suppression de la configuration Caddy",
      ),
    );
  }

  async reloadCaddy(server: ServerRef): Promise<void> {
    await this.withConnection(server, (c) =>
      this.must(c, reloadCaddyScript(DEFAULT_CADDY_PATHS, RELOAD_COMMAND), "Rechargement de Caddy"),
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
