import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { MockMailProvider } from "../providers/mail/mock";
import { setSetting } from "../settings";
import { alertDay, daysUntil, raiseAlert } from "./alerts";
import { alertIfExpiring } from "./domain-refresh";
import { formMessage, runMailSend } from "./mail";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("formMessage", () => {
  const site = {
    clientName: "Boulangerie Dupont",
    domain: "boulangerie-dupont.fr",
    slug: "boulangerie-dupont",
    formsEmail: "contact@boulangerie-dupont.fr",
  };

  it("lists the fields and replies to a valid email", () => {
    const msg = formMessage(
      {
        payload: { nom: "Claire", email: "claire@example.com", message: "Bonjour" },
        env: "production",
        createdAt: new Date(),
      },
      site,
    );
    expect(msg.to).toBe(site.formsEmail);
    expect(msg.subject).toBe("[Boulangerie Dupont] Nouveau message depuis le site");
    expect(msg.text).toContain("nom : Claire");
    expect(msg.text).toContain("message : Bonjour");
    expect(msg.text).toContain("boulangerie-dupont.fr via auscii-deploy");
    expect(msg.replyTo).toBe("claire@example.com");
  });

  it("ignores an invalid reply address and flags preview submissions", () => {
    const msg = formMessage(
      { payload: { email: "pas un email", message: "x" }, env: "preview", createdAt: new Date() },
      { ...site, domain: null },
    );
    expect(msg.replyTo).toBeUndefined();
    expect(msg.subject).toContain("préproduction");
    expect(msg.text).toContain("boulangerie-dupont (préproduction)");
  });
});

describe("alert helpers", () => {
  it("computes days and the deduplication day in UTC", () => {
    const now = new Date("2026-09-02T22:30:00Z");
    expect(daysUntil(new Date("2026-09-12T10:00:00Z"), now)).toBe(9);
    expect(daysUntil(new Date("2026-09-01T00:00:00Z"), now)).toBe(-2);
    expect(alertDay(now).toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });
});

describe.skipIf(!hasDb)("mail.send queue (demo providers, real database)", () => {
  let siteId: string;

  beforeAll(async () => {
    await prisma.site.deleteMany({ where: { slug: "mail-test" } });
    await prisma.alert.deleteMany({ where: { key: { startsWith: "mail-test" } } });
    const site = await prisma.site.create({
      data: {
        slug: "mail-test",
        clientName: "Mail Test",
        domain: "mail-test.fr",
        previewToken: "tok",
        formsEmail: "client@example.com",
        status: "live",
        isDemo: true,
      },
    });
    siteId = site.id;
    await setSetting("alertEmail", "agence@example.com");
  });

  afterAll(async () => {
    await prisma.site.deleteMany({ where: { slug: "mail-test" } });
    await prisma.alert.deleteMany({ where: { key: { startsWith: "mail-test" } } });
    await setSetting("alertEmail", "");
  });

  it("emails a submission once and stamps emailedAt", async () => {
    const submission = await prisma.formSubmission.create({
      data: { siteId, payload: { email: "v@example.com", message: "Bonjour" }, env: "production" },
    });
    const before = MockMailProvider.outbox().length;
    await runMailSend({ kind: "form", submissionId: submission.id });
    const sent = MockMailProvider.outbox().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("client@example.com");
    expect(sent[0].replyTo).toBe("v@example.com");
    const updated = await prisma.formSubmission.findUniqueOrThrow({
      where: { id: submission.id },
    });
    expect(updated.emailedAt).not.toBeNull();

    await runMailSend({ kind: "form", submissionId: submission.id });
    expect(MockMailProvider.outbox().length).toBe(before + 1);
  });

  it("raises one alert per kind, key and day, then emails the agency", async () => {
    const now = new Date("2026-09-02T09:00:00Z");
    const first = await raiseAlert(
      { kind: "tls_failure", key: "mail-test.fr", subject: "HTTPS", body: "détail", isDemo: true },
      now,
    );
    const again = await raiseAlert(
      { kind: "tls_failure", key: "mail-test.fr", subject: "HTTPS", body: "détail", isDemo: true },
      now,
    );
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    const nextDay = await raiseAlert(
      { kind: "tls_failure", key: "mail-test.fr", subject: "HTTPS", body: "détail", isDemo: true },
      new Date("2026-09-03T09:00:00Z"),
    );
    expect(nextDay.created).toBe(true);

    const before = MockMailProvider.outbox().length;
    await runMailSend({ kind: "alert", alertId: first.id });
    const sent = MockMailProvider.outbox().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("agence@example.com");
    expect(sent[0].subject).toContain("HTTPS");
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id: first.id } });
    expect(alert.sentAt).not.toBeNull();
  });

  it("records the missing alert address instead of failing", async () => {
    await setSetting("alertEmail", "");
    const { id } = await raiseAlert({
      kind: "deployment_failed",
      key: "mail-test-deployment",
      subject: "Déploiement",
      body: "x",
      isDemo: true,
    });
    await runMailSend({ kind: "alert", alertId: id });
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id } });
    expect(alert.sentAt).toBeNull();
    expect(alert.error).toMatch(/Paramètres > Agence/);
    await setSetting("alertEmail", "agence@example.com");
  });

  it("alerts on a domain expiring within 30 days only", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000);
    const far = new Date(Date.now() + 90 * 86_400_000);
    expect(await alertIfExpiring("mail-test-far.fr", far, true, true)).toBe(false);
    expect(await alertIfExpiring("mail-test-soon.fr", soon, false, true)).toBe(true);
    const alert = await prisma.alert.findFirstOrThrow({
      where: { kind: "domain_expiry", key: "mail-test-soon.fr" },
    });
    expect(alert.subject).toMatch(/expire dans (9|10) jour/);
    expect(alert.body).toContain("renouvellement automatique est désactivé");
  });
});
