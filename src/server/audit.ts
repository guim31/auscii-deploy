import { prisma } from "./db";
import type { CurrentUser } from "./session";

export async function audit(
  user: Pick<CurrentUser, "id" | "email"> | null,
  action: string,
  opts: {
    target?: string;
    amount?: number;
    currency?: string;
    details?: Record<string, unknown>;
  } = {},
) {
  await prisma.auditLog.create({
    data: {
      userId: user?.id,
      userEmail: user?.email,
      action,
      target: opts.target,
      amount: opts.amount,
      currency: opts.currency,
      details: opts.details as object | undefined,
    },
  });
}
