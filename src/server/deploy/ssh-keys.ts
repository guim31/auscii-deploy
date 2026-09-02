import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { utils } from "ssh2";

export type SshKeyPair = { privateKey: string; publicKey: string; fingerprint: string };

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/**
 * Serializes an ed25519 key in the OpenSSH private key format (unencrypted).
 * Written by hand rather than through ssh2's generator, whose output is
 * occasionally rejected by its own parser.
 */
export function encodeOpenSshEd25519(
  seed: Buffer,
  pub: Buffer,
  comment: string,
): { privateKey: string; publicKey: string } {
  if (seed.length !== 32 || pub.length !== 32) throw new Error("Clé ed25519 invalide");
  const keyType = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = randomBytes(4);
  let privateSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment, "utf8")),
  ]);
  const padding: number[] = [];
  for (let i = 1; privateSection.length % 8 !== 0; i++) {
    privateSection = Buffer.concat([privateSection, Buffer.from([i])]);
    padding.push(i);
  }
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString(Buffer.from("none")),
    sshString(Buffer.from("none")),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}${b64.endsWith("\n") ? "" : "\n"}-----END OPENSSH PRIVATE KEY-----\n`;
  const publicKey = `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`.trim();
  return { privateKey, publicKey };
}

/** Generates an ed25519 key pair in OpenSSH format for the pilot. */
export function generateSshKeyPair(comment = "auscii-deploy"): SshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = spki.subarray(spki.length - 32);
  const encoded = encodeOpenSshEd25519(seed, pub, comment);
  const parsed = utils.parseKey(encoded.privateKey);
  if (parsed instanceof Error) throw new Error(`Clé générée illisible : ${parsed.message}`);
  return { ...encoded, fingerprint: fingerprintOf(parsed.getPublicSSH()) };
}

/** Validates a pasted private key and derives its public key. */
export function inspectPrivateKey(privateKey: string): { publicKey: string; fingerprint: string } {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw new Error(`Clé privée illisible : ${parsed.message}`);
  if (!parsed.isPrivateKey()) throw new Error("Ce n'est pas une clé privée");
  const pub = parsed.getPublicSSH();
  return {
    publicKey:
      `${parsed.type} ${pub.toString("base64")} ${parsed.comment || "auscii-deploy"}`.trim(),
    fingerprint: fingerprintOf(pub),
  };
}

/** SHA256 fingerprint in the OpenSSH display format. */
export function fingerprintOf(publicKeyBytes: Buffer): string {
  return `SHA256:${createHash("sha256").update(publicKeyBytes).digest("base64").replace(/=+$/, "")}`;
}
