import type { NotificationChannel } from "./port";
import { EmailNotificationChannel } from "./email-channel";
import { WebhookNotificationChannel, SlackNotificationChannel } from "./webhook-channel";
import { openChannelConfig } from "./channel-config";

export function createChannel(row: {
  type: "email" | "webhook" | "slack";
  name?: string;
  organizationId: string;
  config: unknown;
}): NotificationChannel {
  const config = openChannelConfig(row);
  switch (row.type) {
    case "email": return new EmailNotificationChannel(config as { recipients: string[] });
    case "webhook": return new WebhookNotificationChannel(config as { url: string; secret?: string });
    case "slack": return new SlackNotificationChannel(config as { webhookUrl: string });
    default: throw new Error(`Unknown channel type: ${row.type}`);
  }
}
