import type { NotificationChannel } from "./port";
import { EmailNotificationChannel } from "./email-channel";
import { WebhookNotificationChannel, SlackNotificationChannel } from "./webhook-channel";

export function createChannel(row: { type: "email" | "webhook" | "slack"; config: unknown }): NotificationChannel {
  switch (row.type) {
    case "email": return new EmailNotificationChannel(row.config as { recipients: string[] });
    case "webhook": return new WebhookNotificationChannel(row.config as { url: string; secret?: string });
    case "slack": return new SlackNotificationChannel(row.config as { webhookUrl: string });
    default: throw new Error(`Unknown channel type: ${row.type}`);
  }
}
