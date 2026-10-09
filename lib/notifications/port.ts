/** Notification channel interface. */

import type { BusEvent } from "@/lib/bus/events";

/** What a channel reports about a send. */
export type DeliveryReceipt = {
  providerMessageIds?: string[];
  /** Some recipients failed; logged on the success row. */
  partialFailure?: string;
};

export interface NotificationChannel {
  send(event: BusEvent): Promise<DeliveryReceipt | void>;
}
