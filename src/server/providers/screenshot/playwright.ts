import type { ScreenshotProvider } from "../types";
import { ProviderNotConfiguredError } from "../types";

/** Real Chromium capture lands in phase 2. */
export class PlaywrightScreenshotProvider implements ScreenshotProvider {
  readonly name = "playwright";

  capture(): Promise<"png"> {
    throw new ProviderNotConfiguredError(
      "Playwright",
      "Les captures réelles arrivent en phase 2. Activez le mode démo.",
    );
  }
}
