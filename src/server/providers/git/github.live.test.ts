/** Optional read-only check against GitHub. Enabled by TEST_GITHUB_APP_ID, TEST_GITHUB_INSTALLATION_ID, TEST_GITHUB_PRIVATE_KEY_PATH, TEST_GITHUB_ORG. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GitHubProvider } from "./github";

const appId = process.env.TEST_GITHUB_APP_ID;
const installationId = process.env.TEST_GITHUB_INSTALLATION_ID;
const keyPath = process.env.TEST_GITHUB_PRIVATE_KEY_PATH;

describe.skipIf(!appId || !installationId || !keyPath)("GitHub live (read-only)", () => {
  it("identifies the app and the installation", async () => {
    const p = new GitHubProvider({
      appId: appId!,
      installationId: installationId!,
      privateKey: readFileSync(keyPath!, "utf8"),
      org: process.env.TEST_GITHUB_ORG ?? "",
    });
    const me = await p.whoAmI();
    expect(me.app).toBeTruthy();
    expect(me.repos).toBeGreaterThanOrEqual(0);
  });
});
