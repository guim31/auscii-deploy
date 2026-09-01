import { createHash } from "node:crypto";

/** Mock delays are scaled by MOCK_SPEED (1 = realistic, 0 = instant). Tests set it to 0. */
export function mockSpeed(): number {
  if (process.env.NODE_ENV === "test") return 0;
  const raw = process.env.MOCK_SPEED;
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

export function sleep(ms: number): Promise<void> {
  const scaled = Math.round(ms * mockSpeed());
  if (scaled <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, scaled));
}

export function fakeSha(seed: string): string {
  return createHash("sha1").update(`${seed}:${Date.now()}:${Math.random()}`).digest("hex");
}

export function hashInt(seed: string, max: number): number {
  const h = createHash("md5").update(seed).digest();
  return h.readUInt32BE(0) % max;
}
