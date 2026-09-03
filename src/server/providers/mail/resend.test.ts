import { describe, expect, it } from "vitest";
import { defaultSender, recordsFromResend, ResendProvider } from "./resend";
import { describeResendError, ResendError } from "./resend-client";
import { ProviderNotConfiguredError } from "../types";

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function fakeFetch(
  routes: Record<string, (call: Call, n: number) => { status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.startsWith(k));
    if (!key)
      return new Response(JSON.stringify({ message: `no route for ${call.method} ${url}` }), {
        status: 500,
      });
    counts[key] = (counts[key] ?? 0) + 1;
    const r = routes[key](call, counts[key]);
    return new Response(
      r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status },
    );
  };
  return { impl, calls };
}

const KEY = "re_secret_123456";
const creds = { apiKey: KEY, from: "AUSCII <no-reply@auscii.site>" };

const DOMAIN = {
  id: "dom_1",
  name: "auscii.site",
  status: "not_started",
  region: "eu-west-1",
  records: [
    {
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "Auto",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send",
      type: "TXT",
      ttl: "Auto",
      value: "v=spf1 include:amazonses.com ~all",
    },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", value: "p=MIGfMA0G" },
  ],
};

describe("ResendProvider", () => {
  it("requires an API key and a sender", async () => {
    await expect(
      new ResendProvider(null).send({ to: "a@b.fr", subject: "s", text: "t" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(
      new ResendProvider({ apiKey: KEY }).send({ to: "a@b.fr", subject: "s", text: "t" }),
    ).rejects.toThrow(/Expéditeur/);
  });

  it("sends an email with the configured sender and reply-to", async () => {
    const { impl, calls } = fakeFetch({
      "POST https://api.resend.com/emails": () => ({ status: 200, body: { id: "email_1" } }),
    });
    const provider = new ResendProvider(creds, impl);
    const res = await provider.send({
      to: "client@example.fr",
      subject: "Nouveau message",
      text: "Bonjour",
      replyTo: "visiteur@example.fr",
    });
    expect(res.id).toBe("email_1");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].body!)).toEqual({
      from: creds.from,
      to: ["client@example.fr"],
      subject: "Nouveau message",
      text: "Bonjour",
      reply_to: "visiteur@example.fr",
    });
  });

  it("lets a message override the sender", async () => {
    const { impl, calls } = fakeFetch({
      "POST https://api.resend.com/emails": () => ({ status: 200, body: { id: "email_2" } }),
    });
    await new ResendProvider(creds, impl).send({
      to: "a@b.fr",
      from: "Alertes <alertes@auscii.site>",
      subject: "s",
      text: "t",
    });
    expect(JSON.parse(calls[0].body!).from).toBe("Alertes <alertes@auscii.site>");
  });

  it("translates errors without leaking the key", async () => {
    const { impl } = fakeFetch({
      "POST https://api.resend.com/emails": () => ({
        status: 403,
        body: {
          statusCode: 403,
          name: "validation_error",
          message: "The auscii.site domain is not verified.",
        },
      }),
    });
    const err = await new ResendProvider(creds, impl)
      .send({ to: "a@b.fr", subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResendError);
    expect((err as ResendError).status).toBe(403);
    expect((err as Error).message).toMatch(/domaine d'envoi/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("declares the sending domain once and returns its records", async () => {
    const declared: ApiDomainState = { exists: false };
    const { impl, calls } = fakeFetch({
      "GET https://api.resend.com/domains/dom_1": () => ({
        status: 200,
        body: { ...DOMAIN, status: "pending" },
      }),
      "GET https://api.resend.com/domains": () => ({
        status: 200,
        body: {
          data: declared.exists ? [{ id: "dom_1", name: "auscii.site", status: "pending" }] : [],
        },
      }),
      "POST https://api.resend.com/domains/dom_1/verify": () => ({
        status: 200,
        body: { object: "domain", id: "dom_1" },
      }),
      "POST https://api.resend.com/domains": (call) => {
        declared.exists = true;
        expect(JSON.parse(call.body!)).toEqual({ name: "auscii.site", region: "eu-west-1" });
        return { status: 201, body: DOMAIN };
      },
    });
    const provider = new ResendProvider(creds, impl);
    const first = await provider.ensureSendingDomain("auscii.site");
    expect(first.id).toBe("dom_1");
    expect(first.status).toBe("not_started");
    expect(first.records).toEqual([
      {
        name: "send",
        type: "MX",
        values: ["10 feedback-smtp.eu-west-1.amazonses.com."],
        ttl: 300,
      },
      { name: "send", type: "TXT", values: ["v=spf1 include:amazonses.com ~all"], ttl: 300 },
      { name: "resend._domainkey", type: "TXT", values: ["p=MIGfMA0G"], ttl: 300 },
    ]);

    const second = await provider.ensureSendingDomain("AUSCII.site");
    expect(second.status).toBe("pending");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/domains"))).toHaveLength(1);

    const verified = await provider.verifyDomain("dom_1");
    expect(verified.status).toBe("pending");
    expect(calls.some((c) => c.url.endsWith("/domains/dom_1/verify"))).toBe(true);
  });

  it("reports the account domains for the settings test", async () => {
    const { impl } = fakeFetch({
      "GET https://api.resend.com/domains": () => ({
        status: 200,
        body: { data: [{ id: "dom_1", name: "auscii.site", status: "verified" }] },
      }),
    });
    const me = await new ResendProvider(creds, impl).whoAmI();
    expect(me.domains).toEqual([
      { id: "dom_1", name: "auscii.site", status: "verified", records: [] },
    ]);
  });

  it("rejects an invalid key with a readable message", async () => {
    const { impl } = fakeFetch({
      "GET https://api.resend.com/domains": () => ({
        status: 401,
        body: { statusCode: 401, name: "invalid_api_key", message: "API key is invalid" },
      }),
    });
    await expect(new ResendProvider(creds, impl).whoAmI()).rejects.toThrow(
      /Clé API Resend invalide/,
    );
  });
});

type ApiDomainState = { exists: boolean };

describe("recordsFromResend", () => {
  it("normalises absolute names and the apex", () => {
    const records = recordsFromResend({
      id: "d",
      name: "auscii.site",
      records: [
        { type: "TXT", name: "auscii.site", value: "v=spf1 -all" },
        { type: "TXT", name: "resend._domainkey.auscii.site", value: "p=abc" },
        { type: "CNAME", name: "track.auscii.site", value: "feedback.resend.com" },
        { type: "A", name: "ignored", value: "1.2.3.4" },
      ],
    });
    expect(records).toEqual([
      { name: "@", type: "TXT", values: ["v=spf1 -all"], ttl: 300 },
      { name: "resend._domainkey", type: "TXT", values: ["p=abc"], ttl: 300 },
      { name: "track", type: "CNAME", values: ["feedback.resend.com."], ttl: 300 },
    ]);
  });
});

describe("describeResendError", () => {
  it("maps the common statuses", () => {
    expect(describeResendError(401, null, "x")).toMatch(/invalide/);
    expect(describeResendError(429, null, "x")).toMatch(/Quota/);
    expect(describeResendError(422, { message: "Invalid `to` field" }, "x")).toMatch(
      /Invalid `to`/,
    );
    expect(describeResendError(500, null, "POST /emails")).toBe(
      "Erreur Resend (500) : POST /emails.",
    );
  });
});

describe("defaultSender", () => {
  it("builds a no-reply sender on the tech domain", () => {
    expect(defaultSender("AUSCII", "auscii.site")).toBe("AUSCII <no-reply@auscii.site>");
  });
});
