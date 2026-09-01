import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

/** Encrypts a UTF-8 string. Output format: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encrypt(plain: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decrypt(payload: string, keyHex: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64)
    throw new Error("Malformed encrypted payload");
  const key = keyFromHex(keyHex);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
  return dec.toString("utf8");
}

export function encryptJson(value: unknown, keyHex: string): string {
  return encrypt(JSON.stringify(value), keyHex);
}

export function decryptJson<T = unknown>(payload: string, keyHex: string): T {
  return JSON.parse(decrypt(payload, keyHex)) as T;
}

/** Random URL-safe token, for preview links. */
export function randomToken(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}
