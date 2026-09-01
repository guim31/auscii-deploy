import { describe, expect, it } from "vitest";
import { describeTlsError, tlsCheckFromCertificate } from "./tls";

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
