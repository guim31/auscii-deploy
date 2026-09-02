import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ScreenshotProvider } from "../types";

/** Captures a page with Chromium. PLAYWRIGHT_CHROMIUM_PATH points to an existing binary when set. */
export class PlaywrightScreenshotProvider implements ScreenshotProvider {
  readonly name = "playwright";

  async capture(url: string, outPath: string, _label: string): Promise<"png"> {
    const { chromium } = await import("playwright-core");
    const target = outPath.replace(/\.svg$/, ".png");
    await mkdir(path.dirname(target), { recursive: true });
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        locale: "fr-FR",
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      await page.screenshot({ path: target, type: "png" });
    } finally {
      await browser.close();
    }
    return "png";
  }
}
