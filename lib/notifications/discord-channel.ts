import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { parseDiscordWebhook } from "./channel-schemas";
import { postJson } from "./provider-http";
import { pushMessageForOrg, type PushMessage, type PushSeverity } from "./push-message";

export type DiscordConfig = { webhookUrl: string };

const COLOR: Record<PushSeverity, number> = {
  critical: 0xe5484d,
  warning: 0xf5a524,
  success: 0x30a46c,
  info: 0x3b82f6,
};

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;
const FIELD_VALUE_MAX = 1024;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The embed for a message: color by severity, title linking to the console, facts as fields. */
export function discordEmbed(msg: PushMessage, now = new Date()) {
  const link = msg.url ? `\n\n[${msg.urlLabel ?? "Open"}](${msg.url.replace(/\)/g, "%29")})` : "";
  return {
    title: cut(msg.title, TITLE_MAX),
    description: cut(msg.summary, DESCRIPTION_MAX - link.length) + link,
    color: COLOR[msg.severity],
    ...(msg.url ? { url: msg.url } : {}),
    fields: msg.facts.map((f) => ({ name: cut(f.label, TITLE_MAX), value: cut(f.value, FIELD_VALUE_MAX), inline: f.value.length <= 30 })),
    footer: { text: `${msg.instanceName} · ${msg.eventType}` },
    timestamp: now.toISOString(),
  };
}

export class DiscordNotificationChannel implements NotificationChannel {
  constructor(
    private config: DiscordConfig,
    private organizationId?: string,
  ) {}

  /** Throws when Discord refuses the message, so dispatch retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    const url = parseDiscordWebhook(this.config.webhookUrl);
    if (!url) throw new Error("The Discord webhook URL isn't a Discord webhook");

    const msg = await pushMessageForOrg(event, this.organizationId);
    if (!msg) return {};

    // wait=true returns the created message instead of an empty 204.
    url.searchParams.set("wait", "true");
    const { status, body } = await postJson(
      "Discord",
      url.toString(),
      { embeds: [discordEmbed(msg)], allowed_mentions: { parse: [] } },
      { secrets: [this.config.webhookUrl, url.pathname.split("/").filter(Boolean).at(-1) ?? ""] },
    );
    const id = (body as { id?: unknown } | null)?.id;
    return { providerStatus: status, ...(typeof id === "string" ? { providerMessageIds: [id] } : {}) };
  }
}
