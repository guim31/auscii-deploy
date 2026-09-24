import type { MailMessage, MailProvider } from "../types";
import { fakeSha, sleep } from "../mock-utils";

const outbox: (MailMessage & { id: string; sentAt: Date })[] = [];

export class MockMailProvider implements MailProvider {
  readonly name = "mock-resend";

  async send(message: MailMessage) {
    await sleep(300);
    // Like Resend: the same idempotency key returns the first email instead of sending again.
    if (message.idempotencyKey) {
      const previous = outbox.find((m) => m.idempotencyKey === message.idempotencyKey);
      if (previous) return { id: previous.id };
    }
    const id = fakeSha(message.to).slice(0, 12);
    outbox.push({ ...message, id, sentAt: new Date() });
    if (outbox.length > 200) outbox.shift();
    return { id };
  }

  static outbox() {
    return outbox;
  }
}
