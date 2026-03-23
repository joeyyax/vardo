import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { NotificationEvent } from "./port";
import { createChannel } from "./factory";
import { emit, onEmit, toBusEvent, toLegacyEvent } from "@/lib/bus";
import type { BusEvent, BusEventType } from "@/lib/bus";

/**
 * Check whether a channel's subscribedEvents filter allows this event.
 * Empty array = subscribe to all (backward compatible default).
 */
function channelAcceptsEvent(
  subscribedEvents: string[],
  eventType: BusEventType,
): boolean {
  if (subscribedEvents.length === 0) return true;
  return subscribedEvents.includes(eventType);
}

/**
 * Dispatch a bus event to all matching notification channels for an org.
 */
function dispatchToChannels(orgId: string, event: BusEvent): void {
  Promise.resolve().then(async () => {
    try {
      const channels = await db.query.notificationChannels.findMany({
        where: and(
          eq(notificationChannels.organizationId, orgId),
          eq(notificationChannels.enabled, true),
        ),
      });
      if (channels.length === 0) return;

      const legacy = toLegacyEvent(event);

      await Promise.allSettled(
        channels.map(async (row) => {
          if (!channelAcceptsEvent(row.subscribedEvents, event.type)) return;
          try {
            await createChannel(row).send(legacy);
          } catch (err) {
            console.error(
              `[notifications] Channel "${row.name}" failed:`,
              err,
            );
          }
        }),
      );
    } catch (err) {
      console.error("[notifications] Dispatch error:", err);
    }
  });
}

// Register as an emit hook so every bus event triggers channel dispatch
onEmit("dispatch", dispatchToChannels);

/**
 * Legacy notify() entrypoint. Converts the event to a typed BusEvent and
 * emits it on the bus. The emit hook above handles channel dispatch.
 *
 * All existing call sites continue to work unchanged.
 */
export function notify(orgId: string, event: NotificationEvent): void {
  emit(orgId, toBusEvent(event));
}

// Re-export emit so call sites can import { emit } from "@/lib/notifications/dispatch"
// and get the dispatch hook registration as a side effect.
export { emit } from "@/lib/bus";
export type { BusEvent, BusEventType } from "@/lib/bus";
