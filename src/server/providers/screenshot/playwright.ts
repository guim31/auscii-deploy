import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { ScreenshotProvider } from "../types";

/** Time left to web fonts, sliders and cookie banners once the page has loaded. */
const SETTLE_MS = 1500;

/**
 * Host names of the pilot's own services (docker compose) and of cloud
 * metadata endpoints: a client page must not make the worker reach them.
 */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "app",
  "worker",
  "db",
  "postgres",
  "caddy",
  "redis",
  "metadata",
  "metadata.google.internal",
]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, Scaleway metadata 169.254.42.42
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      /^ff/.test(lower) || // multicast
      lower.startsWith("64:ff9b:") // NAT64 can point anywhere
    );
  }
  return true;
}

/**
 * Whether the worker may fetch this URL for a screenshot: http(s) only, no
 * internal service name, and every address the name resolves to is public.
 */
export async function isAllowedUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (isIP(host)) return !isBlockedAddress(host);
  if (BLOCKED_HOSTS.has(host) || !host.includes(".") || /\.(local|internal|localhost)$/.test(host))
    return false;
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every((a) => !isBlockedAddress(a));
  } catch {
    return false;
  }
}

/**
 * Captures a page with Chromium. PLAYWRIGHT_CHROMIUM_PATH points to an existing
 * binary when set. The page is a client site: every request goes through
 * isAllowedUrl, so it cannot reach the pilot's services nor the cloud metadata.
 */
export class PlaywrightScreenshotProvider implements ScreenshotProvider {
  readonly name = "playwright";

  async capture(url: string, outPath: string, _label: string): Promise<"png"> {
    if (!(await isAllowedUrl(url))) throw new Error(`Adresse refusée pour la capture : ${url}`);
    const { chromium } = await import("playwright-core");
    const target = outPath.replace(/\.svg$/, ".png");
    await mkdir(path.dirname(target), { recursive: true });
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      // The worker image runs Chromium without its own sandbox (no user
      // namespaces in the container); PLAYWRIGHT_CHROMIUM_SANDBOX=1 keeps it
      // where the host allows it.
      args:
        process.env.PLAYWRIGHT_CHROMIUM_SANDBOX === "1"
          ? ["--disable-dev-shm-usage"]
          : ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        locale: "fr-FR",
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const verdicts = new Map<string, Promise<boolean>>();
      const allowed = (requestUrl: string): Promise<boolean> => {
        if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:"))
          return Promise.resolve(true);
        let key: string;
        try {
          const u = new URL(requestUrl);
          key = `${u.protocol}//${u.host}`;
        } catch {
          return Promise.resolve(false);
        }
        if (!verdicts.has(key)) verdicts.set(key, isAllowedUrl(requestUrl));
        return verdicts.get(key)!;
      };
      await context.route("**/*", async (route) => {
        if (await allowed(route.request().url())) await route.continue();
        else await route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 20_000 });
      await page.waitForTimeout(SETTLE_MS);
      await page.screenshot({ path: target, type: "png" });
    } finally {
      await browser.close();
    }
    return "png";
  }
}
