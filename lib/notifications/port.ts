/** Notification channel interface. */

import type { BusEvent } from "@/lib/bus/events";

/** What a channel reports about a send. */
export type DeliveryReceipt = { providerMessageIds?: string[] };

export interface NotificationChannel {
  send(event: BusEvent): Promise<DeliveryReceipt | void>;
}
