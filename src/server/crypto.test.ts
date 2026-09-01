import { describe, expect, it } from "vitest";
import { decrypt, decryptJson, encrypt, encryptJson, randomToken } from "./crypto";

const KEY = "7f3b2c1d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c";

describe("crypto", () => {
  it("round-trips a string", () => {
    const enc = encrypt("clé secrète é€", KEY);
    expect(enc).not.toContain("clé");
    expect(decrypt(enc, KEY)).toBe("clé secrète é€");
  });

  it("produces different ciphertexts for the same input", () => {
    expect(encrypt("x", KEY)).not.toBe(encrypt("x", KEY));
  });

  it("round-trips JSON", () => {
    const enc = encryptJson({ token: "abc", n: 1 }, KEY);
    expect(decryptJson(enc, KEY)).toEqual({ token: "abc", n: 1 });
  });

  it("rejects a tampered payload", () => {
    const enc = encrypt("hello", KEY);
    const parts = enc.split(".");
    parts[3] = parts[3].slice(0, -2) + "AA";
    expect(() => decrypt(parts.join("."), KEY)).toThrow();
  });

  it("rejects a wrong key", () => {
    const enc = encrypt("hello", KEY);
    expect(() => decrypt(enc, "0".repeat(64))).toThrow();
  });

  it("generates url-safe tokens", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
