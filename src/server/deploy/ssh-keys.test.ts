import { describe, expect, it } from "vitest";
import { utils } from "ssh2";
import { fingerprintOf, generateSshKeyPair, inspectPrivateKey } from "./ssh-keys";

describe("ssh keys", () => {
  it("generates an OpenSSH ed25519 pair that ssh2 can parse", () => {
    const pair = generateSshKeyPair("test");
    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ test$/);
    expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const parsed = utils.parseKey(pair.privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
  });

  it("derives the public key from a private key", () => {
    const pair = generateSshKeyPair("x");
    const info = inspectPrivateKey(pair.privateKey);
    expect(info.publicKey.split(" ").slice(0, 2)).toEqual(pair.publicKey.split(" ").slice(0, 2));
    expect(info.fingerprint).toBe(pair.fingerprint);
  });

  it("rejects garbage", () => {
    expect(() => inspectPrivateKey("not a key")).toThrow(/illisible/);
  });

  it("formats fingerprints like OpenSSH", () => {
    expect(fingerprintOf(Buffer.from("abc"))).toMatch(/^SHA256:/);
    expect(fingerprintOf(Buffer.from("abc"))).not.toMatch(/=$/);
  });
});
