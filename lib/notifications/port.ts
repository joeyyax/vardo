/** Notification channel interface. */

import type { BusEvent } from "@/lib/bus/events";

export interface NotificationChannel {
  send(event: BusEvent): Promise<void>;
}
