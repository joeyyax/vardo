import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { sendEmail } from "@/lib/email/send";
import { renderNotificationEmail, type MailContext } from "@/lib/email/notification-email";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

type EmailConfig = { recipients: string[] };

/** Console origin, instance name and time zone for the email header, footer, links and times. */
async function mailContext(organizationId: string | undefined): Promise<MailContext> {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  let instanceName = "Vardo";
  try {
    const { getInstanceDisplayName } = await import("@/lib/system-settings");
    instanceName = (await getInstanceDisplayName()) || new URL(baseUrl).hostname;
  } catch {
    // Defaults stand.
  }
  let timeZone: string | undefined;
  try {
    const { getOrgTimeZone } = await import("@/lib/time-zone-settings");
    timeZone = await getOrgTimeZone(organizationId);
  } catch {
    // Prints UTC.
  }
  return { baseUrl, instanceName, timeZone };
}

export class EmailNotificationChannel implements NotificationChannel {
  constructor(
    private config: EmailConfig,
    private organizationId?: string,
  ) {}

  /** The delivery policy's verdict for this org. Settings that can't be read leave the default. */
  private async wants(event: BusEvent): Promise<boolean> {
    const { emailsEvent, needsSettings } = await import("./delivery-policy");
    if (!needsSettings(event) || !this.organizationId) return emailsEvent(event, { categories: {} });
    try {
      const { readOrgNotificationSettings } = await import("./preferences");
      return emailsEvent(event, await readOrgNotificationSettings(this.organizationId));
    } catch {
      return emailsEvent(event, { categories: {} });
    }
  }

  /** Throws when no recipient got the email, so dispatch logs a failure and retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    if (!(await this.wants(event))) return {};
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
