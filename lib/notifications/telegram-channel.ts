import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { postJson } from "./provider-http";
import { pushMessageForOrg, type PushMessage } from "./push-message";

export type TelegramConfig = { botToken: string; chatId: string };

/** Escapes every character MarkdownV2 reserves in plain text. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/** Escapes a link target, where only ")" and "\" are special. */
function escapeLinkUrl(url: string): string {
  return url.replace(/[\\)]/g, "\\$&");
}

/** MarkdownV2 text: bold title, summary, bold fact labels, then the console link. */
export function telegramText(msg: PushMessage): string {
  const e = escapeMarkdownV2;
  const parts = [`*${e(msg.title)}*`, e(msg.summary)];
  if (msg.facts.length) parts.push(msg.facts.map((f) => `*${e(f.label)}:* ${e(f.value)}`).join("\n"));
  if (msg.url) parts.push(`[${e(msg.urlLabel ?? "Open")}](${escapeLinkUrl(msg.url)})`);
  return parts.filter(Boolean).join("\n\n");
}

export class TelegramNotificationChannel implements NotificationChannel {
  constructor(
    private config: TelegramConfig,
    private organizationId?: string,
  ) {}

  /** Throws when Telegram refuses the message, so dispatch retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    const msg = await pushMessageForOrg(event, this.organizationId);
    if (!msg) return {};

    const { status, body } = await postJson(
      "Telegram",
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        chat_id: this.config.chatId,
        text: telegramText(msg),
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
        disable_notification: msg.severity === "info" || msg.severity === "success",
      },
      { secrets: [this.config.botToken] },
    );
    const reply = body as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
    if (reply?.ok === false) throw new Error(`Telegram refused the message: ${reply.description ?? "no reason given"}`);
    const id = reply?.result?.message_id;
    return { providerStatus: status, ...(id !== undefined ? { providerMessageIds: [String(id)] } : {}) };
  }
}
