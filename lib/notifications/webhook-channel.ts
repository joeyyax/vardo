import { createHmac } from "crypto";
import type { NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

const WEBHOOK_TIMEOUT = 10_000;

export class WebhookNotificationChannel implements NotificationChannel {
  constructor(private config: { url: string; secret?: string }) {}

  async send(event: BusEvent): Promise<void> {
    const payload = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.secret) {
      const signature = createHmac("sha256", this.config.secret)
        .update(payload)
        .digest("hex");
      headers["X-Signature-256"] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      if (!response.ok) {
        log.error(`Webhook returned ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SlackNotificationChannel implements NotificationChannel {
  constructor(private config: { webhookUrl: string }) {}

  async send(event: BusEvent): Promise<void> {
    const emoji = event.type.includes("success")
      ? ":white_check_mark:"
      : ":x:";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `${emoji} *${event.title}*\n${event.message}`,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        log.error(`Slack returned ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
