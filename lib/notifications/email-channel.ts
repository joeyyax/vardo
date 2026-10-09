import { eq } from "drizzle-orm";
import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { sendEmail } from "@/lib/email/send";
import { renderNotificationEmail, type MailContext } from "@/lib/email/notification-email";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

type EmailConfig = { recipients: string[] };

/** Console origin, instance name and org name for the email footer and links. */
async function mailContext(organizationId: string | undefined): Promise<MailContext> {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  let instanceName = "Vardo";
  let orgName: string | undefined;
  try {
    const { getInstanceDisplayName } = await import("@/lib/system-settings");
    instanceName = (await getInstanceDisplayName()) || new URL(baseUrl).hostname;
  } catch {
    // Defaults stand.
  }
  if (organizationId) {
    try {
      const { db } = await import("@/lib/db");
      const { organizations } = await import("@/lib/db/schema");
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
        columns: { name: true },
      });
      orgName = org?.name;
    } catch {
      // Footer leaves the org out.
    }
  }
  return { baseUrl, instanceName, orgName };
}

export class EmailNotificationChannel implements NotificationChannel {
  constructor(
    private config: EmailConfig,
    private organizationId?: string,
  ) {}

  /** Throws when no recipient got the email, so dispatch logs a failure and retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
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
