import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { enqueue, QUEUES } from "./boss";
import type { MailSendPayload } from "./mail";

export type AlertKind =
  "domain_expiry" | "tls_failure" | "deployment_failed" | "server_unreachable";

export type AlertInput = {
  kind: AlertKind;
  /** What the alert is about (a domain, a site id…): one alert per kind, key and day. */
  key: string;
  subject: string;
  body: string;
  isDemo?: boolean;
};

/** Days until the given date, rounded down; negative when already past. */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

const PARIS_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day in Paris of the given instant (as a UTC midnight date), used as the deduplication day. */
export function alertDay(now = new Date()): Date {
  return new Date(`${PARIS_DAY.format(now)}T00:00:00.000Z`);
}

/**
 * Records an alert and queues its email. A second call for the same kind and
 * key on the same day is a no-op, so daily jobs can call it freely.
 */
export async function raiseAlert(
  input: AlertInput,
  now = new Date(),
): Promise<{ id: string; created: boolean }> {
  try {
    const alert = await prisma.alert.create({
      data: {
        kind: input.kind,
        key: input.key,
        day: alertDay(now),
        subject: input.subject,
        body: input.body,
        isDemo: input.isDemo ?? false,
      },
    });
    // A failed enqueue is caught up by the hourly resendPendingAlerts().
    await enqueue(QUEUES.mailSend, {
      kind: "alert",
      alertId: alert.id,
    } satisfies MailSendPayload).catch((err) =>
      console.error("[alerts] mise en file impossible", err instanceof Error ? err.message : err),
    );
    return { id: alert.id, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.alert.findUniqueOrThrow({
        where: { kind_key_day: { kind: input.kind, key: input.key, day: alertDay(now) } },
        select: { id: true },
      });
      return { id: existing.id, created: false };
    }
    throw err;
  }
}

export const DOMAIN_EXPIRY_ALERT_DAYS = 30;
