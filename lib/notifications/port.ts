/** Notification channel interface. */

import type { BusEvent } from "@/lib/bus/events";

/** What a channel reports about a send. */
export type DeliveryReceipt = {
  providerMessageIds?: string[];
  /** Some recipients failed; logged on the success row. */
  partialFailure?: string;
  /** HTTP status from a webhook or Slack endpoint. */
  providerStatus?: number;
};

/** What the factory knows about earlier sends for the same incident. */
export type SendContext = {
  /** This channel's message for the incident's opening notice. */
  priorMessageId?: string;
};

export interface NotificationChannel {
  send(event: BusEvent, ctx?: SendContext): Promise<DeliveryReceipt | void>;
}
