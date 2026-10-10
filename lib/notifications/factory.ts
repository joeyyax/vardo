import type { BusEvent } from "@/lib/bus/events";
import { singleIncident } from "@/lib/incidents/event";
import { channelMessage, rememberChannelMessage, safely } from "@/lib/incidents/store";
import type { DeliveryReceipt, NotificationChannel } from "./port";
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

/** Channels that edit or reply to an incident's earlier message. */
const THREADED: ReadonlySet<string> = new Set(["discord", "telegram"]);

/** Sends with the channel's earlier message for the incident, and remembers the opening one. */
async function threadedSend(
  send: NotificationChannel["send"],
  row: { id?: string; type: string },
  event: BusEvent,
): Promise<DeliveryReceipt | void> {
  const incident = singleIncident(event);
  const channelId = row.id;
  if (!incident || !channelId || !THREADED.has(row.type)) return send(event);
  const prior = incident.transition === "opened" ? null : await safely("read message", () => channelMessage(incident.id, channelId), null);
  const receipt = await send(event, prior ? { priorMessageId: prior } : {});
  const id = receipt?.providerMessageIds?.[0];
  if (id && id !== prior && (!prior || row.type === "discord")) {
    await safely("remember message", () => rememberChannelMessage(incident.id, channelId, id), undefined);
  }
  return receipt;
}

/** A channel whose every send is redacted first. */
export function createChannel(row: {
  id?: string;
  type: ChannelType;
  name?: string;
  organizationId: string;
  config: unknown;
}): NotificationChannel {
  const channel = build(row.type, openChannelConfig(row), row.organizationId);
  const send = channel.send.bind(channel);
  channel.send = async (event) => threadedSend(send, row, await redactEvent(row.organizationId, event));
  return channel;
}
