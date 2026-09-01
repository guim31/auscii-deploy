import type { CloudProvider, CloudServer, ServerOffer } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type ScalewayCredentials = { secretKey: string; projectId: string; defaultZone?: string };

/** Real Scaleway Instances implementation lands in phase 4. */
export class ScalewayProvider implements CloudProvider {
  readonly name = "scaleway";
  constructor(private readonly creds: ScalewayCredentials | null) {}

  private notReady(): never {
    if (!this.creds?.secretKey)
      throw new ProviderNotConfiguredError(
        "Scaleway",
        "Clé API Scaleway manquante (Paramètres > Intégrations).",
      );
    throw new ProviderNotConfiguredError(
      "Scaleway",
      "L'intégration Scaleway réelle arrive en phase 4. Activez le mode démo.",
    );
  }

  listOffers(_zone: string): Promise<ServerOffer[]> {
    return this.notReady();
  }
  createServer(): Promise<CloudServer> {
    return this.notReady();
  }
  getServer(): Promise<CloudServer> {
    return this.notReady();
  }
  deleteServer(): Promise<void> {
    return this.notReady();
  }
}
