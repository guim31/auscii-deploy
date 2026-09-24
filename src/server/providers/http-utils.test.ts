import { describe, expect, it } from "vitest";
import {
  cleanSecret,
  fetchWithRetry,
  hasForbiddenHeaderChars,
  NetworkError,
  networkErrorReason,
  sanitizeMessage,
} from "./http-utils";

const SECRET = "sk-live-1234567890abcdef";

describe("credential hygiene", () => {
  it("trims pasted secrets and spots characters a header cannot carry", () => {
    expect(cleanSecret("  abc\n")).toBe("abc");
    expect(cleanSecret(undefined)).toBe("");
    expect(hasForbiddenHeaderChars("abc")).toBe(false);
    expect(hasForbiddenHeaderChars("ab\ncd")).toBe(true);
    expect(hasForbiddenHeaderChars("ab\tcd")).toBe(true);
    expect(hasForbiddenHeaderChars("ab€cd")).toBe(true);
  });

  it("masks secrets, bearer and basic headers, and URL credentials", () => {
    const msg = sanitizeMessage(
      `Headers.append: "Bearer ${SECRET}" invalid; https://x-access-token:ghs_abc123@github.com/a/b.git; AUTHORIZATION: basic eHl6OmFiYw==; raw ${SECRET}`,
      [SECRET],
    );
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain("ghs_abc123");
    expect(msg).not.toContain("eHl6OmFiYw==");
  });

  it("never copies the message of a header TypeError", async () => {
    // What Node's fetch really throws for a secret with an inner newline.
    let thrown: unknown;
    try {
      new Headers({ Authorization: `Bearer ${SECRET}\nsecond-line` });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    const reason = networkErrorReason(thrown, []);
    expect(reason).not.toContain(SECRET);
    expect(reason).toMatch(/en-tête/);
  });
});

describe("fetchWithRetry", () => {
  function scripted(statuses: (number | "throw")[]) {
    const calls: string[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const next = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      if (next === "throw") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ n: calls.length }), { status: next });
    };
    return { impl, calls };
  }

  it("retries idempotent reads on 429 and 5xx", async () => {
    const { impl, calls } = scripted([503, 429, 200]);
    const res = await fetchWithRetry(impl, "https://x/a", { method: "GET" }, { timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the last attempt and returns the error response", async () => {
    const { impl, calls } = scripted([500]);
    const res = await fetchWithRetry(impl, "https://x/a", { method: "GET" }, { timeoutMs: 1000 });
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it("never retries a write (a retried POST could buy twice)", async () => {
    const { impl, calls } = scripted([503, 200]);
    const res = await fetchWithRetry(impl, "https://x/a", { method: "POST" }, { timeoutMs: 1000 });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("retries network errors on reads, then throws a secret-free NetworkError", async () => {
    const { impl, calls } = scripted(["throw"]);
    const err = await fetchWithRetry(
      impl,
      "https://x/a",
      { method: "GET" },
      { timeoutMs: 1000, secrets: [SECRET] },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(3);
  });

  it("aborts a request after the timeout", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    const err = await fetchWithRetry(
      hang,
      "https://x/a",
      { method: "POST" },
      { timeoutMs: 10 },
    ).catch((e: unknown) => e);
    expect((err as NetworkError).reason).toBe("délai dépassé");
  });
});
