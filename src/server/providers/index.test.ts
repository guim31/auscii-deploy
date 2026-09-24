import { describe, expect, it } from "vitest";
import { getSettings } from "../settings";
import { getProviders } from "./index";
import { defaultSender, ResendProvider } from "./mail/resend";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("getProviders", () => {
  it("follows the demo flag of the entity, not the global mode", async () => {
    // The test environment forces DEMO_MODE=true.
    expect((await getProviders()).demo).toBe(true);
    const real = await getProviders({ demo: false });
    expect(real.demo).toBe(false);
    expect(real.mail).toBeInstanceOf(ResendProvider);
  });

  it("gives Resend the agency sender as a fallback", async () => {
    const settings = await getSettings();
    const mail = (await getProviders({ demo: false })).mail as ResendProvider;
    expect(mail.senderFor({})).toBe(defaultSender(settings.agencyName, settings.techDomain));
    expect(mail.senderFor({ from: "Autre <a@b.c>" })).toBe("Autre <a@b.c>");
  });
});
