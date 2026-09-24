import { describe, expect, it } from "vitest";
import { isAllowedUrl, isBlockedAddress } from "./playwright";

describe("screenshot request filter", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.42.42",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["51.15.0.1", "172.32.0.1", "8.8.8.8", "2001:4860:4860::8888"])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("checks names, schemes and resolved addresses", async () => {
    const dns = async (host: string) =>
      ({ "client.fr": ["51.15.0.1"], "rebind.example": ["51.15.0.1", "10.0.0.5"] })[host] ?? [];
    expect(await isAllowedUrl("https://client.fr/", dns)).toBe(true);
    expect(await isAllowedUrl("https://rebind.example/", dns)).toBe(false);
    expect(await isAllowedUrl("http://app:3000/api/health", dns)).toBe(false);
    expect(await isAllowedUrl("http://db:5432/", dns)).toBe(false);
    expect(await isAllowedUrl("http://169.254.42.42/conf", dns)).toBe(false);
    expect(await isAllowedUrl("http://[::1]/", dns)).toBe(false);
    expect(await isAllowedUrl("file:///etc/passwd", dns)).toBe(false);
    expect(await isAllowedUrl("https://unknown.example/", dns)).toBe(false);
  });
});
