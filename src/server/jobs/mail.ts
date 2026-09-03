import type { FormSubmission, Site } from "@prisma/client";
import { prisma } from "../db";
import { getProviders, ProviderNotConfiguredError, type MailMessage } from "../providers";
import { getSettings } from "../settings";
import { enqueue, QUEUES } from "./boss";

export type MailSendPayload =
  { kind: "form"; submissionId: string } | { kind: "alert"; alertId: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Builds the email relayed to the client for one contact-form submission. Pure. */
export function formMessage(
  submission: Pick<FormSubmission, "payload" | "env" | "createdAt">,
  site: Pick<Site, "clientName" | "domain" | "slug" | "formsEmail">,
): MailMessage {
  const fields = (submission.payload ?? {}) as Record<string, string>;
  const lines = Object.entries(fields).map(([k, v]) => `${k} : ${v}`);
  const origin = site.domain ?? site.slug;
  const where = submission.env === "preview" ? `${origin} (préproduction)` : origin;
  const replyTo = fields.email?.trim();
  return {
    to: site.formsEmail ?? "",
    subject:
      submission.env === "preview"
        ? `[${site.clientName}] Message de test depuis la préproduction`
        : `[${site.clientName}] Nouveau message depuis le site`,
    text: `${lines.join("\n")}\n\n— Envoyé depuis ${where} via auscii-deploy`,
    ...(replyTo && EMAIL.test(replyTo) ? { replyTo } : {}),
  };
}

/** Queues the email of a submission. Idempotent per submission thanks to the singleton key. */
export async function queueSubmissionMail(submissionId: string): Promise<void> {
  await enqueue(QUEUES.mailSend, { kind: "form", submissionId } satisfies MailSendPayload, {
    singletonKey: `form:${submissionId}`,
  });
}

/**
 * Worker handler for the mail.send queue. A missing configuration is final
 * (logged, no retry); any other failure throws so pg-boss retries later.
 */
export async function runMailSend(payload: MailSendPayload): Promise<void> {
  const providers = await getProviders();
  if (payload.kind === "form") {
    const submission = await prisma.formSubmission.findUnique({
      where: { id: payload.submissionId },
      include: { site: true },
    });
    if (!submission || submission.emailedAt) return;
    if (!submission.site.formsEmail) return;
    try {
      await providers.mail.send(formMessage(submission, submission.site));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        console.warn(`[mail] message ${submission.id} non transmis : ${err.message}`);
        return;
      }
      throw err;
    }
    await prisma.formSubmission.update({
      where: { id: submission.id },
      data: { emailedAt: new Date() },
    });
    return;
  }

  const alert = await prisma.alert.findUnique({ where: { id: payload.alertId } });
  if (!alert || alert.sentAt) return;
  const settings = await getSettings();
  const to = settings.alertEmail.trim();
  if (!to) {
    await prisma.alert.update({
      where: { id: alert.id },
      data: { error: "Aucune adresse d'alerte (Paramètres > Agence)." },
    });
    return;
  }
  try {
    await providers.mail.send({
      to,
      subject: `[${settings.agencyName}] ${alert.subject}`,
      text: alert.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.alert.update({ where: { id: alert.id }, data: { error: message } });
    if (err instanceof ProviderNotConfiguredError) {
      console.warn(`[mail] alerte ${alert.id} non envoyée : ${message}`);
      return;
    }
    throw err;
  }
  await prisma.alert.update({
    where: { id: alert.id },
    data: { sentAt: new Date(), error: null },
  });
}
