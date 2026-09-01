import type { ServerAgent, ServerMetrics, ServerRef, TlsCheck } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type SshCredentials = { privateKey: string; publicKey: string };

/** Real ssh2-based agent lands in phase 2. */
export class SshServerAgent implements ServerAgent {
  readonly name = "ssh";
  constructor(private readonly creds: SshCredentials | null) {}

  private notReady(): never {
    if (!this.creds?.privateKey)
      throw new ProviderNotConfiguredError(
        "SSH",
        "Clé SSH du pilote absente (Paramètres > Serveurs).",
      );
    throw new ProviderNotConfiguredError(
      "SSH",
      "Le déploiement SSH réel arrive en phase 2. Activez le mode démo.",
    );
  }

  waitReady(): Promise<void> {
    return this.notReady();
  }
  exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.notReady();
  }
  ensureSiteDirs(): Promise<void> {
    return this.notReady();
  }
  uploadRelease(): Promise<void> {
    return this.notReady();
  }
  switchRelease(): Promise<void> {
    return this.notReady();
  }
  writeCaddySite(): Promise<void> {
    return this.notReady();
  }
  removeCaddySite(): Promise<void> {
    return this.notReady();
  }
  reloadCaddy(): Promise<void> {
    return this.notReady();
  }
  collectMetrics(_server: ServerRef): Promise<ServerMetrics> {
    return this.notReady();
  }
  checkTls(_host: string): Promise<TlsCheck> {
    return this.notReady();
  }
}
