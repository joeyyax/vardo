import type { NotificationChannel } from "./port";
import { EmailNotificationChannel } from "./email-channel";
import { WebhookNotificationChannel, SlackNotificationChannel } from "./webhook-channel";
import { openChannelConfig } from "./channel-config";
import { redactEvent } from "./redact-event";

function build(type: string, config: unknown): NotificationChannel {
  switch (type) {
    case "email": return new EmailNotificationChannel(config as { recipients: string[] });
    case "webhook": return new WebhookNotificationChannel(config as { url: string; secret?: string });
    case "slack": return new SlackNotificationChannel(config as { webhookUrl: string });
    default: throw new Error(`Unknown channel type: ${type}`);
  }
}

/** A channel whose every send is redacted first. */
export function createChannel(row: {
  type: "email" | "webhook" | "slack";
  name?: string;
  organizationId: string;
  config: unknown;
}): NotificationChannel {
  const channel = build(row.type, openChannelConfig(row));
  const send = channel.send.bind(channel);
  channel.send = async (event) => send(await redactEvent(row.organizationId, event));
  return channel;
}
