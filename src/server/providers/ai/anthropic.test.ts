import { describe, expect, it } from "vitest";
import {
  AnthropicError,
  AnthropicProvider,
  buildUserMessage,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
} from "./anthropic";
import { ProviderNotConfiguredError } from "../types";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(routes: Record<string, (call: Call) => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: `no route ${url}` }), { status: 500 });
    const r = routes[key](call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const KEY = "sk-ant-secret-key-000";
const creds = { apiKey: KEY };

const REPORT = {
  summary: "Le site peut partir en préproduction.",
  seo: [{ level: "warn", message: "La page contact n'a pas de titre." }],
  accessibility: [{ level: "ok", message: "Les images ont un texte alternatif." }],
  content: [{ level: "info", message: "Ajoutez les horaires d'ouverture." }],
};

function message(text: string, stopReason = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const input = {
  clientName: "Boulangerie Dupont",
  files: [{ path: "index.html", size: 100 }],
  pages: [
    { path: "index.html", title: "Accueil", text: "Pain au levain depuis 1987." },
    { path: "contact.html", text: "Nous écrire" },
  ],
  facts: ["1 page(s) sans balise <title>."],
};

describe("AnthropicProvider", () => {
  it("requires an API key", async () => {
    await expect(new AnthropicProvider(null).analyzeSite(input)).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
  });

  it("asks for a structured report and returns it", async () => {
    const { impl, calls } = fakeFetch({
      "POST https://api.anthropic.com/v1/messages": () => ({
        status: 200,
        body: message(JSON.stringify(REPORT)),
      }),
    });
    const report = await new AnthropicProvider(creds, impl).analyzeSite(input);
    expect(report.summary).toBe(REPORT.summary);
    expect(report.seo).toEqual(REPORT.seo);
    expect(report.generatedBy).toBe("Claude (claude-opus-5)");

    expect(calls).toHaveLength(1);
    const body = calls[0].body as Record<string, unknown>;
    expect(calls[0].headers["x-api-key"]).toBe(KEY);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.system).toBe(SYSTEM_PROMPT);
    const format = (body.output_config as { format: { type: string; schema: object } }).format;
    expect(format.type).toBe("json_schema");
    expect(JSON.stringify(format.schema)).toContain("accessibility");
    const user = (body.messages as { content: string }[])[0].content;
    expect(user).toContain("Client : Boulangerie Dupont");
    expect(user).toContain("Constats automatiques");
    expect(user).toContain("Pain au levain");
  });

  it("uses the configured model", async () => {
    const { impl, calls } = fakeFetch({
      "POST https://api.anthropic.com/v1/messages": () => ({
        status: 200,
        body: { ...message(JSON.stringify(REPORT)), model: "claude-sonnet-5" },
      }),
    });
    const report = await new AnthropicProvider(
      { apiKey: KEY, model: "claude-sonnet-5" },
      impl,
    ).analyzeSite(input);
    expect((calls[0].body as { model: string }).model).toBe("claude-sonnet-5");
    expect(report.generatedBy).toBe("Claude (claude-sonnet-5)");
  });

  it("reports a refusal instead of an empty report", async () => {
    const { impl } = fakeFetch({
      "POST https://api.anthropic.com/v1/messages": () => ({
        status: 200,
        body: { ...message(""), content: [], stop_reason: "refusal" },
      }),
    });
    await expect(new AnthropicProvider(creds, impl).analyzeSite(input)).rejects.toThrow(/refusé/);
  });

  it("translates an invalid key without leaking it", async () => {
    const { impl } = fakeFetch({
      "POST https://api.anthropic.com/v1/messages": () => ({
        status: 401,
        body: {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
      }),
    });
    const err = await new AnthropicProvider(creds, impl)
      .analyzeSite(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicError);
    expect((err as AnthropicError).status).toBe(401);
    expect((err as Error).message).toMatch(/Clé API Anthropic invalide/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("identifies the model for the settings test", async () => {
    const { impl, calls } = fakeFetch({
      "GET https://api.anthropic.com/v1/models/claude-opus-5": () => ({
        status: 200,
        body: {
          id: "claude-opus-5",
          type: "model",
          display_name: "Claude Opus 5",
          created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 1_000_000,
        },
      }),
    });
    const me = await new AnthropicProvider(creds, impl).whoAmI();
    expect(me).toEqual({
      model: "claude-opus-5",
      displayName: "Claude Opus 5",
      contextWindow: 1_000_000,
    });
    expect(calls[0].headers["x-api-key"]).toBe(KEY);
  });

  it("explains an unknown model", async () => {
    const { impl } = fakeFetch({
      "GET https://api.anthropic.com/v1/models/": () => ({
        status: 404,
        body: { type: "error", error: { type: "not_found_error", message: "model not found" } },
      }),
    });
    await expect(
      new AnthropicProvider({ apiKey: KEY, model: "claude-inconnu" }, impl).whoAmI(),
    ).rejects.toThrow(/Modèle Anthropic inconnu/);
  });
});

describe("buildUserMessage", () => {
  it("keeps the input within budget and flags untransmitted pages", () => {
    const pages = Array.from({ length: 45 }, (_, i) => ({
      path: `p${i}.html`,
      title: `Page ${i}`,
      text: "x".repeat(5000),
    }));
    const text = buildUserMessage({ clientName: "Test", files: [], pages });
    expect(text.length).toBeLessThan(90_000);
    expect(text).toContain("5 page(s) supplémentaires non transmises");
    expect(text).not.toContain("p44.html");
    expect(text).toContain("(titre : Page 0)");
  });
});
