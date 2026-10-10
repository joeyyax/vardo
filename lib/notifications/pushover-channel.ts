import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { postJson } from "./provider-http";
import { pushMessageForOrg, type PushMessage, type PushSeverity } from "./push-message";

export type PushoverConfig = { userKey: string; appToken: string };

/** Critical breaks through quiet hours; info and successes make no sound. */
const PRIORITY: Record<PushSeverity, number> = { critical: 1, warning: 0, success: -1, info: -1 };

const TITLE_MAX = 250;
const MESSAGE_MAX = 1024;
const URL_MAX = 512;
const URL_TITLE_MAX = 100;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The summary first, then one line per fact. */
export function pushoverMessage(msg: PushMessage): string {
  return cut([msg.summary, ...(msg.facts.length ? ["", ...msg.facts.map((f) => `${f.label}: ${f.value}`)] : [])].join("\n"), MESSAGE_MAX);
}

export class PushoverNotificationChannel implements NotificationChannel {
  constructor(
    private config: PushoverConfig,
    private organizationId?: string,
  ) {}

  /** Throws when Pushover refuses the message, so dispatch retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    const msg = await pushMessageForOrg(event, this.organizationId);
    if (!msg) return {};

    const { status, body } = await postJson(
      "Pushover",
      "https://api.pushover.net/1/messages.json",
      {
        token: this.config.appToken,
        user: this.config.userKey,
        title: cut(msg.title, TITLE_MAX),
        message: pushoverMessage(msg),
        priority: PRIORITY[msg.severity],
        ...(msg.url && msg.url.length <= URL_MAX ? { url: msg.url, url_title: cut(msg.urlLabel ?? "Open", URL_TITLE_MAX) } : {}),
      },
      { secrets: [this.config.appToken, this.config.userKey] },
    );
    const reply = body as { status?: number; request?: string; errors?: string[] } | null;
    if (reply?.status !== undefined && reply.status !== 1) {
      throw new Error(`Pushover refused the message: ${(reply.errors ?? []).join("; ") || "no reason given"}`);
    }
    return { providerStatus: status, ...(reply?.request ? { providerMessageIds: [reply.request] } : {}) };
  }
}
