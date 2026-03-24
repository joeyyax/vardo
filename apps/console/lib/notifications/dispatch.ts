import { db } from "@/lib/db";
import { notificationChannels, notificationLogs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { NotificationEvent } from "./port";
import { createChannel } from "./factory";
import { enqueueRetry } from "./retry";
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

            // Log success
            try {
              await db.insert(notificationLogs).values({
                id: nanoid(),
                organizationId: orgId,
                channelId: row.id,
                channelName: row.name,
                channelType: row.type,
                eventType: event.type,
                eventTitle: legacy.title || event.type,
                status: "success",
                attempt: 1,
              });
            } catch {
              // Don't let logging failures break dispatch
            }
          } catch (err) {
            console.warn(
              `[notifications] Channel "${row.name}" failed, enqueuing retry:`,
              err instanceof Error ? err.message : err,
            );

            // Enqueue for retry instead of silently dropping
            try {
              await enqueueRetry({
                orgId,
                channelId: row.id,
                channelName: row.name,
                channelType: row.type,
                event,
              }, 1);
            } catch {
              // If even enqueueing fails, log the failure directly
              try {
                await db.insert(notificationLogs).values({
                  id: nanoid(),
                  organizationId: orgId,
                  channelId: row.id,
                  channelName: row.name,
                  channelType: row.type,
                  eventType: event.type,
                  eventTitle: legacy.title || event.type,
                  status: "failed",
                  error: err instanceof Error ? err.message : String(err),
                  attempt: 1,
                });
              } catch {
                // Last resort — already logged to console above
              }
            }
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
