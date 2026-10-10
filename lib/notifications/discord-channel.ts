import type { DeliveryReceipt, NotificationChannel, SendContext } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { singleIncident } from "@/lib/incidents/event";
import { parseDiscordWebhook } from "./channel-schemas";
import { postJson, ProviderError } from "./provider-http";
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

  /** Throws when Discord refuses the message, so dispatch retries. A resolution edits the incident's opening message in place. */
  async send(event: BusEvent, ctx: SendContext = {}): Promise<DeliveryReceipt> {
    const url = parseDiscordWebhook(this.config.webhookUrl);
    if (!url) throw new Error("The Discord webhook URL isn't a Discord webhook");

    const msg = await pushMessageForOrg(event, this.organizationId);
    if (!msg) return {};

    const payload = { embeds: [discordEmbed(msg)], allowed_mentions: { parse: [] } };
    const secrets = [this.config.webhookUrl, url.pathname.split("/").filter(Boolean).at(-1) ?? ""];
    const prior = ctx.priorMessageId;
    if (prior && /^\d+$/.test(prior) && singleIncident(event)?.transition === "resolved") {
      const edit = new URL(`${url.origin}${url.pathname.replace(/\/+$/, "")}/messages/${prior}`);
      const thread = url.searchParams.get("thread_id");
      if (thread) edit.searchParams.set("thread_id", thread);
      try {
        const { status } = await postJson("Discord", edit.toString(), payload, { secrets, method: "PATCH" });
        return { providerStatus: status, providerMessageIds: [prior] };
      } catch (err) {
        // A deleted message gets a new one.
        if (!(err instanceof ProviderError && err.providerStatus === 404)) throw err;
      }
    }

    // wait=true returns the created message instead of an empty 204.
    url.searchParams.set("wait", "true");
    const { status, body } = await postJson("Discord", url.toString(), payload, { secrets });
    const id = (body as { id?: unknown } | null)?.id;
    return { providerStatus: status, ...(typeof id === "string" ? { providerMessageIds: [id] } : {}) };
  }
}
