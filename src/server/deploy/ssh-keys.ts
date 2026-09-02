import { createHash } from "node:crypto";
import { utils } from "ssh2";

export type SshKeyPair = { privateKey: string; publicKey: string; fingerprint: string };

/** Generates an ed25519 key pair in OpenSSH format for the pilot. */
export function generateSshKeyPair(comment = "auscii-deploy"): SshKeyPair {
  const pair = utils.generateKeyPairSync("ed25519", { comment });
  const parsed = utils.parseKey(pair.private);
  if (parsed instanceof Error) throw parsed;
  return {
    privateKey: pair.private,
    publicKey: pair.public.trim(),
    fingerprint: fingerprintOf(parsed.getPublicSSH()),
  };
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
