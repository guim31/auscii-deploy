import type { MailMessage, MailProvider } from "../types";
import { fakeSha, sleep } from "../mock-utils";

const outbox: (MailMessage & { id: string; sentAt: Date })[] = [];

export class MockMailProvider implements MailProvider {
  readonly name = "mock-resend";

  async send(message: MailMessage) {
    await sleep(300);
    const id = fakeSha(message.to).slice(0, 12);
    outbox.push({ ...message, id, sentAt: new Date() });
    if (outbox.length > 200) outbox.shift();
    return { id };
  }

  static outbox() {
    return outbox;
  }
}
