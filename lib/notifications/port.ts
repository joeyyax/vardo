/**
 * Notification channel interface.
 *
 * Channels receive typed BusEvents directly — no legacy conversion layer.
 */

import type { BusEvent } from "@/lib/bus/events";

export interface NotificationChannel {
  send(event: BusEvent): Promise<void>;
}
