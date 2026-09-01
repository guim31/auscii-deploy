import type {
  DomainAvailability,
  DomainContact,
  DomainOrder,
  DomainProvider,
  DnsRecord,
} from "../types";
import { ProviderNotConfiguredError } from "../types";

export type GandiCredentials = { apiKey: string; organizationId?: string };

/** Real Gandi v5 implementation lands in phase 3. */
export class GandiProvider implements DomainProvider {
  readonly name = "gandi";
  constructor(private readonly creds: GandiCredentials | null) {}

  private notReady(): never {
    if (!this.creds?.apiKey)
      throw new ProviderNotConfiguredError(
        "Gandi",
        "Clé API Gandi manquante (Paramètres > Intégrations).",
      );
    throw new ProviderNotConfiguredError(
      "Gandi",
      "L'intégration Gandi réelle arrive en phase 3. Activez le mode démo.",
    );
  }

  check(_fqdn: string): Promise<DomainAvailability> {
    return this.notReady();
  }
  suggest(_base: string): Promise<DomainAvailability[]> {
    return this.notReady();
  }
  register(_fqdn: string, _contact: DomainContact): Promise<DomainOrder> {
    return this.notReady();
  }
  getOrder(_orderId: string): Promise<DomainOrder> {
    return this.notReady();
  }
  listOwned(): Promise<string[]> {
    return this.notReady();
  }
  setRecords(_zone: string, _records: DnsRecord[]): Promise<void> {
    return this.notReady();
  }
}
