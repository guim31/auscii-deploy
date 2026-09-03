/** Optional read-only check against Anthropic. Enabled by TEST_ANTHROPIC_API_KEY. */
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic";

const apiKey = process.env.TEST_ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)("Anthropic live (read-only)", () => {
  it("identifies the default model", async () => {
    const me = await new AnthropicProvider({ apiKey: apiKey! }).whoAmI();
    expect(me.model).toBeTruthy();
    expect(me.displayName).toBeTruthy();
  });
});
