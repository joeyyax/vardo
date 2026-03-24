import { createHmac } from "crypto";
import type { NotificationChannel, NotificationEvent } from "./port";

export class WebhookNotificationChannel implements NotificationChannel {
  constructor(private config: { url: string; secret?: string }) {}
  async send(event: NotificationEvent): Promise<void> {
    const payload = JSON.stringify({ type: event.type, title: event.title, message: event.message, metadata: event.metadata, timestamp: new Date().toISOString() });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.secret) headers["X-Signature-256"] = `sha256=${createHmac("sha256", this.config.secret).update(payload).digest("hex")}`;
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10_000);
    try { const r = await fetch(this.config.url, { method: "POST", headers, body: payload, signal: c.signal }); if (!r.ok) console.error(`[notifications] Webhook returned ${r.status}`); } finally { clearTimeout(t); }
  }
}

export class SlackNotificationChannel implements NotificationChannel {
  constructor(private config: { webhookUrl: string }) {}
  async send(event: NotificationEvent): Promise<void> {
    const emoji = event.type.includes("success") ? ":white_check_mark:" : ":x:";
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10_000);
    try { const r = await fetch(this.config.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${emoji} *${event.title}*\n${event.message}` }), signal: c.signal }); if (!r.ok) console.error(`[notifications] Slack returned ${r.status}`); } finally { clearTimeout(t); }
  }
}
