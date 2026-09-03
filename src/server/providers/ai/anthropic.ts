import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { AiProvider, AiReport, AiSiteInput } from "../types";
import { ProviderNotConfiguredError } from "../types";

export type AnthropicCredentials = { apiKey: string; model?: string };

export const DEFAULT_MODEL = "claude-opus-5";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Input budget: enough to read a showcase site, never the whole archive. */
const MAX_PAGES = 40;
const MAX_CHARS_PER_PAGE = 3000;
const MAX_TOTAL_CHARS = 80_000;

const findingSchema = z.object({
  level: z.enum(["ok", "info", "warn"]),
  message: z.string(),
});

export const reportSchema = z.object({
  summary: z.string(),
  seo: z.array(findingSchema),
  accessibility: z.array(findingSchema),
  content: z.array(findingSchema),
});

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

/** Translates SDK errors for the settings page and the worker logs; never quotes the key. */
export function describeAnthropicError(err: unknown): AnthropicError {
  if (err instanceof Anthropic.AuthenticationError)
    return new AnthropicError("Clé API Anthropic invalide (Paramètres > Intégrations).", 401);
  if (err instanceof Anthropic.PermissionDeniedError)
    return new AnthropicError(
      "La clé API Anthropic n'a pas accès à ce modèle. Vérifiez l'organisation et le modèle choisi.",
      403,
    );
  if (err instanceof Anthropic.NotFoundError)
    return new AnthropicError(
      "Modèle Anthropic inconnu. Laissez le champ vide pour utiliser le modèle par défaut.",
      404,
    );
  if (err instanceof Anthropic.RateLimitError)
    return new AnthropicError(
      "Limite de débit Anthropic atteinte, réessayez dans une minute.",
      429,
    );
  if (err instanceof Anthropic.BadRequestError)
    return new AnthropicError(`Anthropic a refusé la demande : ${err.message}.`, 400);
  if (err instanceof Anthropic.InternalServerError)
    return new AnthropicError(
      "Anthropic est temporairement indisponible, réessayez plus tard.",
      500,
    );
  if (err instanceof Anthropic.APIConnectionError)
    return new AnthropicError("Anthropic injoignable (réseau ou délai dépassé).", 0);
  if (err instanceof Anthropic.APIError)
    return new AnthropicError(
      `Erreur Anthropic (${err.status ?? "?"}) : ${err.message}.`,
      err.status ?? 0,
    );
  if (err instanceof AnthropicError) return err;
  return new AnthropicError(err instanceof Error ? err.message : String(err), 0);
}

export const SYSTEM_PROMPT = `Tu es le relecteur d'une agence web française qui publie des sites vitrine statiques pour des commerçants et des professions libérales. On te donne le texte des pages d'un site avant sa mise en ligne, ainsi que des constats déjà établis par une analyse automatique.

Rédige un rapport court et concret, en français, destiné à un gérant non technicien :
- "summary" : deux phrases maximum. Dis si le site peut partir en préproduction et ce qu'il faudrait corriger avant la mise en production.
- "seo" : titres, descriptions, structure des pages, mots-clés locaux (ville, activité), pages manquantes évidentes.
- "accessibility" : lisibilité, images, formulaires, structure des titres, liens explicites.
- "content" : cohérence avec le nom du client, mentions légales et coordonnées, fautes ou textes de remplissage (lorem ipsum, "à compléter"), ton et clarté.

Règles : 3 à 5 constats par rubrique, une phrase chacun, sans jargon. Niveau "warn" pour ce qui doit être corrigé avant la production, "info" pour une amélioration, "ok" pour un point validé. Ne répète pas les constats automatiques déjà fournis, sauf pour les compléter. N'invente rien qui n'apparaît pas dans le texte fourni.`;

/** Builds the user message from the pages, within the input budget. Pure. */
export function buildUserMessage(input: AiSiteInput): string {
  const parts: string[] = [`Client : ${input.clientName}`];
  parts.push(`Fichiers : ${input.files.length}, pages HTML : ${input.pages.length}.`);
  if (input.facts?.length) parts.push(`Constats automatiques :\n- ${input.facts.join("\n- ")}`);
  let budget = MAX_TOTAL_CHARS;
  const pages = input.pages.slice(0, MAX_PAGES);
  for (const page of pages) {
    if (budget <= 0) break;
    const text = page.text.slice(0, Math.min(MAX_CHARS_PER_PAGE, budget));
    budget -= text.length;
    parts.push(
      `--- Page ${page.path}${page.title ? ` (titre : ${page.title})` : " (sans titre)"} ---\n${text}`,
    );
  }
  if (input.pages.length > pages.length)
    parts.push(`(${input.pages.length - pages.length} page(s) supplémentaires non transmises)`);
  return parts.join("\n\n");
}

/** Real Claude implementation of the step-3 report, using structured outputs. */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  constructor(
    private readonly creds: AnthropicCredentials | null,
    private readonly fetchImpl?: FetchLike,
  ) {}

  get model(): string {
    return this.creds?.model?.trim() || DEFAULT_MODEL;
  }

  private client(): Anthropic {
    if (!this.creds?.apiKey)
      throw new ProviderNotConfiguredError(
        "Anthropic",
        "Clé API Anthropic manquante (Paramètres > Intégrations).",
      );
    return new Anthropic({
      apiKey: this.creds.apiKey,
      maxRetries: 2,
      timeout: 120_000,
      ...(this.fetchImpl ? { fetch: this.fetchImpl as never } : {}),
    });
  }

  async analyzeSite(input: AiSiteInput): Promise<AiReport> {
    const client = this.client();
    try {
      const response = await client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(input) }],
        output_config: { format: zodOutputFormat(reportSchema) },
      });
      if (response.stop_reason === "refusal")
        throw new AnthropicError("Claude a refusé d'analyser ce contenu.", 200);
      if (response.stop_reason === "max_tokens")
        throw new AnthropicError("Rapport interrompu (trop long), réessayez.", 200);
      const parsed = response.parsed_output;
      if (!parsed) throw new AnthropicError("Réponse de Claude illisible, réessayez.", 200);
      return { ...parsed, generatedBy: `Claude (${response.model})` };
    } catch (err) {
      throw describeAnthropicError(err);
    }
  }

  /** Used by the settings "Tester" button: checks the key and the model. */
  async whoAmI(): Promise<{ model: string; displayName: string; contextWindow: number | null }> {
    const client = this.client();
    try {
      const info = await client.models.retrieve(this.model);
      return {
        model: info.id,
        displayName: info.display_name,
        contextWindow: info.max_input_tokens ?? null,
      };
    } catch (err) {
      throw describeAnthropicError(err);
    }
  }
}
