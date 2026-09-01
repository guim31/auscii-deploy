import type { AiProvider, AiReport, AiSiteInput } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type AnthropicCredentials = { apiKey: string; model?: string };

/** Real Claude API implementation lands in phase 7. */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  constructor(private readonly creds: AnthropicCredentials | null) {}

  analyzeSite(_input: AiSiteInput): Promise<AiReport> {
    if (!this.creds?.apiKey)
      throw new ProviderNotConfiguredError(
        "Anthropic",
        "Clé API Anthropic manquante (Paramètres > Intégrations).",
      );
    throw new ProviderNotConfiguredError(
      "Anthropic",
      "L'analyse Claude réelle arrive en phase 7. Activez le mode démo.",
    );
  }
}
