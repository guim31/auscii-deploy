import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetFormRateLimit,
  formRateLimited,
  parseFormBody,
  readRelay,
  safeRedirect,
} from "./forms";
import { relaySecretFor, RELAY_HEADERS } from "./deploy/relay";

function headers(extra: Record<string, string>) {
  return new Headers(extra);
}

describe("readRelay", () => {
  it("accepts a request signed with the site's secret", () => {
    const relay = readRelay(
      headers({
        [RELAY_HEADERS.site]: "dupont",
        [RELAY_HEADERS.secret]: relaySecretFor("dupont"),
        [RELAY_HEADERS.clientIp]: "203.0.113.9",
        [RELAY_HEADERS.env]: "preview",
      }),
    );
    expect(relay).toMatchObject({ slug: "dupont", clientIp: "203.0.113.9", env: "preview" });
  });
  it("refuses a missing, wrong or other site's secret", () => {
    expect(readRelay(headers({ [RELAY_HEADERS.site]: "dupont" }))).toBeNull();
    expect(
      readRelay(
        headers({ [RELAY_HEADERS.site]: "dupont", [RELAY_HEADERS.secret]: "x".repeat(32) }),
      ),
    ).toBeNull();
    expect(
      readRelay(
        headers({
          [RELAY_HEADERS.site]: "dupont",
          [RELAY_HEADERS.secret]: relaySecretFor("autre"),
        }),
      ),
    ).toBeNull();
  });
});

describe("parseFormBody", () => {
  it("parses url-encoded forms and keeps the redirect apart", () => {
    const r = parseFormBody(
      "nom=A&message=Bonjour&_redirect=%2Fmerci.html",
      "application/x-www-form-urlencoded",
    );
    expect(r).toEqual({
      ok: true,
      fields: { nom: "A", message: "Bonjour" },
      redirect: "/merci.html",
      honeypot: false,
    });
  });
  it("rejects invalid or oversized JSON without throwing", () => {
    expect(parseFormBody("null", "application/json")).toMatchObject({ ok: false, status: 400 });
    expect(parseFormBody("[1]", "application/json")).toMatchObject({ ok: false, status: 400 });
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, "x"]));
    expect(parseFormBody(JSON.stringify(many), "application/json")).toMatchObject({ status: 413 });
  });
  it("flags the honeypot and keeps a real website field", () => {
    expect(parseFormBody("_gotcha=bot&message=x", "")).toMatchObject({ ok: true, honeypot: true });
    expect(parseFormBody("website=https://a.fr&message=x", "")).toMatchObject({
      ok: true,
      honeypot: false,
      fields: { website: "https://a.fr" },
    });
  });
});

describe("safeRedirect", () => {
  it("only allows same-site paths", () => {
    expect(safeRedirect("/merci.html")).toBe("/merci.html");
    expect(safeRedirect("//evil.com")).toBeNull();
    expect(safeRedirect("/\\evil.com")).toBeNull();
    expect(safeRedirect("https://evil.com")).toBeNull();
  });
});

describe("formRateLimited", () => {
  beforeEach(() => _resetFormRateLimit());
  it("limits one visitor without blocking the others", () => {
    for (let i = 0; i < 5; i++) expect(formRateLimited("s", "1.1.1.1", 1000)).toBe(false);
    expect(formRateLimited("s", "1.1.1.1", 1000)).toBe(true);
    expect(formRateLimited("s", "2.2.2.2", 1000)).toBe(false);
  });
});
