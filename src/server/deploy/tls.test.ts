import { describe, expect, it, vi } from "vitest";
import type { TlsCheck } from "../providers/types";
import {
  checkTlsWithRetry,
  describeTlsCode,
  describeTlsError,
  tlsCheckFromCertificate,
} from "./tls";

describe("tlsCheckFromCertificate", () => {
  it("accepts a valid authorized certificate", () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toUTCString();
    const r = tlsCheckFromCertificate(
      "dupont.fr",
      { issuer: { O: "Let's Encrypt", CN: "R11" }, valid_to: future },
      true,
    );
    expect(r.ok).toBe(true);
    expect(r.issuer).toBe("Let's Encrypt R11");
    expect(r.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("flags unauthorized and expired certificates", () => {
    const past = new Date(Date.now() - 86_400_000).toUTCString();
    expect(tlsCheckFromCertificate("a", { valid_to: past }, true).error).toMatch(/expiré/);
    expect(tlsCheckFromCertificate("a", { valid_to: past }, false, "self signed").error).toBe(
      "self signed",
    );
    expect(tlsCheckFromCertificate("a", {}, true).error).toMatch(/Aucun certificat/);
  });

  it("explains common network errors in French", () => {
    expect(describeTlsError({ code: "ENOTFOUND", message: "x" } as NodeJS.ErrnoException)).toMatch(
      /DNS/,
    );
    expect(
      describeTlsError({ code: "ECONNREFUSED", message: "x" } as NodeJS.ErrnoException),
    ).toMatch(/443/);
    expect(describeTlsError({ code: "OTHER", message: "boom" } as NodeJS.ErrnoException)).toBe(
      "boom",
    );
  });
});

describe("error translation", () => {
  it("translates certificate verification codes", () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toUTCString();
    const check = (code: string) =>
      tlsCheckFromCertificate("dupont.fr", { valid_to: future }, false, code).error;
    expect(check("CERT_HAS_EXPIRED")).toBe("Certificat expiré");
    expect(check("ERR_TLS_CERT_ALTNAME_INVALID")).toMatch(/ne correspond pas/);
    expect(check("DEPTH_ZERO_SELF_SIGNED_CERT")).toMatch(/auto-signé/);
    expect(check("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).toMatch(/autorité non reconnue/);
  });

  it("translates network and handshake errors", () => {
    expect(describeTlsCode("TIMEOUT")).toMatch(/Délai dépassé/);
    expect(describeTlsCode("ETIMEDOUT")).toMatch(/Délai dépassé/);
    expect(describeTlsCode("ECONNRESET")).toMatch(/coupée/);
    expect(describeTlsCode("EHOSTUNREACH")).toMatch(/injoignable/);
    expect(describeTlsCode("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR")).toMatch(
      /pas encore de certificat/,
    );
    expect(describeTlsCode("ERR_SSL_SOMETHING_NEW")).toMatch(/négociation HTTPS \(something new\)/);
    expect(describeTlsCode(undefined, "raw")).toBe("raw");
    expect(describeTlsCode(undefined)).toBe("Erreur inconnue");
  });
});

describe("checkTlsWithRetry", () => {
  const ok: TlsCheck = { host: "dupont.fr", ok: true, issuer: "Let's Encrypt" };
  const pending: TlsCheck = { host: "dupont.fr", ok: false, error: "auto-signé" };

  it("retries while the certificate is being issued", async () => {
    const results = [pending, pending, ok];
    const agent = { checkTls: vi.fn(async () => results.shift()!) };
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    const r = await checkTlsWithRetry(agent, "dupont.fr", {
      attempts: 5,
      delayMs: 7,
      sleep,
      onRetry,
    });
    expect(r).toEqual(ok);
    expect(agent.checkTls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("returns the last failure after the last attempt, without throwing", async () => {
    const agent = {
      checkTls: vi
        .fn<(host: string) => Promise<TlsCheck>>()
        .mockResolvedValueOnce(pending)
        .mockRejectedValueOnce(new Error("boom")),
    };
    const r = await checkTlsWithRetry(agent, "dupont.fr", {
      attempts: 2,
      sleep: async () => undefined,
    });
    expect(r).toEqual({ host: "dupont.fr", ok: false, error: "boom" });
  });
});
