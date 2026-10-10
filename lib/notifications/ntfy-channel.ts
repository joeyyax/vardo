import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { DEFAULT_NTFY_SERVER } from "./channel-schemas";
import { postJson } from "./provider-http";
import { pushMessageForOrg, type PushMessage, type PushSeverity } from "./push-message";

export type NtfyConfig = {
  serverUrl?: string;
  topic: string;
  accessToken?: string;
  username?: string;
  password?: string;
  /** Default on. Servers older than ntfy 2.7 ignore the flag and show the raw text. */
  markdown?: boolean;
};

const PRIORITY: Record<PushSeverity, number> = { critical: 5, warning: 4, success: 3, info: 3 };

const BODY_MAX = 3500;

/** Backslash-escapes the characters Markdown would read as formatting. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()#>~|]/g, "\\$&");
}

/** The summary first, then one line per fact. */
export function ntfyBody(msg: PushMessage, markdown: boolean): string {
  const esc = markdown ? escapeMarkdown : (t: string) => t;
  const lines = msg.facts.map((f) => (markdown ? `**${esc(f.label)}:** ${esc(f.value)}` : `${f.label}: ${f.value}`));
  const body = [esc(msg.summary), ...(lines.length ? ["", ...lines] : [])].join("\n");
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body;
}

function authHeader(config: NtfyConfig): Record<string, string> {
  if (config.accessToken) return { Authorization: `Bearer ${config.accessToken}` };
  if (config.username && config.password) {
    return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` };
  }
  return {};
}

export class NtfyNotificationChannel implements NotificationChannel {
  constructor(
    private config: NtfyConfig,
    private organizationId?: string,
  ) {}

  /** Throws when the server refuses the message, so dispatch retries. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    const msg = await pushMessageForOrg(event, this.organizationId);
    if (!msg) return {};

    const markdown = this.config.markdown !== false;
    const server = (this.config.serverUrl || DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
    const { status, body } = await postJson(
      "ntfy",
      `${server}/`,
      {
        topic: this.config.topic,
        title: msg.title,
        message: ntfyBody(msg, markdown),
        priority: PRIORITY[msg.severity],
        tags: [msg.emoji],
        ...(markdown ? { markdown: true } : {}),
        ...(msg.url ? { click: msg.url, actions: [{ action: "view", label: msg.urlLabel, url: msg.url }] } : {}),
      },
      {
        headers: authHeader(this.config),
        secrets: [this.config.accessToken, this.config.password, this.config.topic].filter((s): s is string => Boolean(s)),
      },
    );
    const id = (body as { id?: unknown } | null)?.id;
    return { providerStatus: status, ...(typeof id === "string" ? { providerMessageIds: [id] } : {}) };
  }
}
