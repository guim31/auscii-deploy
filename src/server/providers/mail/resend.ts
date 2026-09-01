import type { MailMessage, MailProvider } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type ResendCredentials = { apiKey: string; from: string };

/** Real Resend implementation lands in phase 6. */
export class ResendProvider implements MailProvider {
  readonly name = "resend";
  constructor(private readonly creds: ResendCredentials | null) {}

  send(_message: MailMessage): Promise<{ id: string }> {
    if (!this.creds?.apiKey)
      throw new ProviderNotConfiguredError(
        "Resend",
        "Clé API Resend manquante (Paramètres > Intégrations).",
      );
    throw new ProviderNotConfiguredError(
      "Resend",
      "L'intégration Resend réelle arrive en phase 6. Activez le mode démo.",
    );
  }
}
