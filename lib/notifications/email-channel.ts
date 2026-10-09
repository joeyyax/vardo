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

  async send(event: BusEvent): Promise<DeliveryReceipt> {
    const { loadMailSeries } = await import("@/lib/email/series");
    const [ctx, series] = await Promise.all([mailContext(this.organizationId), loadMailSeries(event).catch(() => ({}))]);
    const email = await renderNotificationEmail(event, { ...ctx, series });
    if (!email) return {};
    const providerMessageIds: string[] = [];
    for (const recipient of this.config.recipients) {
      try {
        const result = await sendEmail({ to: recipient, subject: email.subject, html: email.html, text: email.text });
        if (result.messageId) providerMessageIds.push(result.messageId);
      } catch (err) {
        log.error(`Failed to send email to ${recipient}:`, err);
      }
    }
    return providerMessageIds.length > 0 ? { providerMessageIds } : {};
  }
}
