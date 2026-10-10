import { createHmac } from "crypto";
import type { DeliveryReceipt, NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/security/safe-fetch";
import { getOutboundPolicy } from "@/lib/security/outbound-policy";
import { PAYLOAD_VERSION } from "@/lib/incidents/types";
import { singleIncident } from "@/lib/incidents/event";

const log = logger.child("notifications");

const WEBHOOK_TIMEOUT = 10_000;

/** One body per incident: an alert notice covering several splits so each POST maps to one ticket. */
export function webhookPayloads(event: BusEvent, timestamp = new Date().toISOString()): Record<string, unknown>[] {
  const base = { version: PAYLOAD_VERSION, ...event, timestamp };
  if ((event.type === "alert.fired" || event.type === "alert.resolved") && event.alerts.length > 1) {
    return event.alerts.map((alert, i) => {
      const rest: Record<string, unknown> = { ...base };
      delete rest.incident;
      return {
        ...rest,
        id: `${event.id ?? "evt"}:${alert.incident?.id ?? i + 1}`,
        title: event.type === "alert.resolved" ? `Resolved: ${alert.title}` : alert.title,
        message: alert.title,
        alerts: [alert],
        ...(alert.incident ? { incident: alert.incident } : {}),
      };
    });
  }
  const incident = singleIncident(event);
  return [incident ? { ...base, incident } : base];
}

export class WebhookNotificationChannel implements NotificationChannel {
  constructor(private config: { url: string; secret?: string }) {}

  /** Throws when any body failed to send, so dispatch retries. Receivers dedupe on `id`. */
  async send(event: BusEvent): Promise<DeliveryReceipt> {
    let status = 0;
    const failures: string[] = [];
    for (const body of webhookPayloads(event)) {
      try {
        status = await this.post(JSON.stringify(body));
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) throw new Error(`Webhook failed: ${failures.join("; ")}`);
    return { providerStatus: status };
  }

  private async post(payload: string): Promise<number> {
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
      const response = await safeFetch(this.config.url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
        policy: await getOutboundPolicy(),
      });
      if (!response.ok) {
        log.error(`Webhook returned ${response.status}`);
      }
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SlackNotificationChannel implements NotificationChannel {
  constructor(private config: { webhookUrl: string }) {}

  async send(event: BusEvent): Promise<DeliveryReceipt> {
    if (event.type === "alert.resolved" && event.quiet) return {};
    const emoji = event.type === "notification.test"
      ? ":wave:"
      : event.type.includes("success")
        ? ":white_check_mark:"
        : ":x:";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    try {
      const response = await safeFetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `${emoji} *${event.title}*\n${event.message}`,
        }),
        signal: controller.signal,
        policy: await getOutboundPolicy(),
      });
      if (!response.ok) {
        log.error(`Slack returned ${response.status}`);
      }
      return { providerStatus: response.status };
    } finally {
      clearTimeout(timer);
    }
  }
}
