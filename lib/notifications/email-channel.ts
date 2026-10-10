import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { mailContext, orgWantsEvent } from "./mail-context";
import { sendEmail } from "@/lib/email/send";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

type EmailConfig = { recipients: string[] };

export class EmailNotificationChannel implements NotificationChannel {
  constructor(
    private config: EmailConfig,
    private organizationId?: string,
  ) {}

  /** Throws when no recipient got the email, so dispatch logs a failure and retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    if (!(await orgWantsEvent(event, this.organizationId))) return {};
    const { loadMailSeries } = await import("@/lib/email/series");
    const [ctx, series] = await Promise.all([mailContext(this.organizationId), loadMailSeries(event).catch(() => ({}))]);
    const email = await renderNotificationEmail(event, { ...ctx, series });
    if (!email || this.config.recipients.length === 0) return {};

    const providerMessageIds: string[] = [];
    const failures: string[] = [];
    for (const recipient of this.config.recipients) {
      try {
        const result = await sendEmail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
        if (!result.success) {
          failures.push(`${recipient}: ${result.error ?? "rejected"}`);
          continue;
        }
        if (result.messageId) providerMessageIds.push(result.messageId);
      } catch (err) {
        failures.push(`${recipient}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failures.length === this.config.recipients.length) {
      throw new Error(`Email not sent to any recipient. ${failures.join("; ")}`);
    }
    if (failures.length > 0) {
      log.warn(`Email reached ${this.config.recipients.length - failures.length} of ${this.config.recipients.length} recipients: ${failures.join("; ")}`);
    }
    return {
      ...(providerMessageIds.length > 0 ? { providerMessageIds } : {}),
      ...(failures.length > 0 ? { partialFailure: `Not sent to ${failures.length} of ${this.config.recipients.length}: ${failures.join("; ")}` } : {}),
    };
  }
}
