import type { NotificationChannel } from "./port";
import type { ChannelType } from "./channel-types";
import { EmailNotificationChannel } from "./email-channel";
import { WebhookNotificationChannel, SlackNotificationChannel } from "./webhook-channel";
import { NtfyNotificationChannel, type NtfyConfig } from "./ntfy-channel";
import { DiscordNotificationChannel, type DiscordConfig } from "./discord-channel";
import { TelegramNotificationChannel, type TelegramConfig } from "./telegram-channel";
import { PushoverNotificationChannel, type PushoverConfig } from "./pushover-channel";
import { openChannelConfig } from "./channel-config";
import { redactEvent } from "./redact-event";

function build(type: string, config: unknown, organizationId: string): NotificationChannel {
  switch (type) {
    case "email": return new EmailNotificationChannel(config as { recipients: string[] }, organizationId);
    case "webhook": return new WebhookNotificationChannel(config as { url: string; secret?: string });
    case "slack": return new SlackNotificationChannel(config as { webhookUrl: string });
    case "ntfy": return new NtfyNotificationChannel(config as NtfyConfig, organizationId);
    case "discord": return new DiscordNotificationChannel(config as DiscordConfig, organizationId);
    case "telegram": return new TelegramNotificationChannel(config as TelegramConfig, organizationId);
    case "pushover": return new PushoverNotificationChannel(config as PushoverConfig, organizationId);
    default: throw new Error(`Unknown channel type: ${type}`);
  }
}

/** A channel whose every send is redacted first. */
export function createChannel(row: {
  type: ChannelType;
  name?: string;
  organizationId: string;
  config: unknown;
}): NotificationChannel {
  const channel = build(row.type, openChannelConfig(row), row.organizationId);
  const send = channel.send.bind(channel);
  channel.send = async (event) => send(await redactEvent(row.organizationId, event));
  return channel;
}
