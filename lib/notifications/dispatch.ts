import { db } from "@/lib/db";
import { notificationChannels, notificationLogs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createChannel } from "./factory";
import { enqueueRetry } from "./retry";
import { emit, onEmit } from "@/lib/bus";
import type { BusEvent, BusEventType } from "@/lib/bus";
import { logger } from "@/lib/logger";
import { fetchOrgMembers, fetchEventPrefs, resolveRecipients } from "./resolve-recipients";

const log = logger.child("notifications");

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

/** Best-effort insert into notification_log. */
async function logNotification(
  orgId: string,
  row: { id: string; name: string; type: string },
  eventType: string,
  eventTitle: string | undefined,
  status: "success" | "failed",
  error?: string,
): Promise<void> {
  try {
    await db.insert(notificationLogs).values({
      id: nanoid(),
      organizationId: orgId,
      channelId: row.id,
      channelName: row.name,
      channelType: row.type,
      eventType,
      eventTitle: eventTitle || eventType,
      status,
      error,
      attempt: 1,
    });
  } catch {
    // Don't let logging failures break dispatch
  }
}

/** Handle a channel send failure - enqueue retry, or log directly as last resort. */
async function handleChannelFailure(
  orgId: string,
  row: { id: string; name: string; type: string },
  event: BusEvent,
  err: unknown,
): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : String(err);
  log.warn(`Channel "${row.name}" failed, enqueuing retry: ${errorMsg}`);

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
    await logNotification(orgId, row, event.type, event.title, "failed", errorMsg);
  }
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

      const members = await fetchOrgMembers(orgId);
      const memberIds = members.map((m) => m.userId);
      const prefs = await fetchEventPrefs(orgId, event.type, memberIds);

      await Promise.allSettled(
        channels.map(async (row) => {
          if (!channelAcceptsEvent(row.subscribedEvents, event.type)) return;

          const { shouldSend } = resolveRecipients(
            row.id,
            row.type,
            event.type,
            members,
            prefs,
          );
          if (!shouldSend) return;

          try {
            await createChannel(row).send(event);
            await logNotification(orgId, row, event.type, event.title, "success");
          } catch (err) {
            await handleChannelFailure(orgId, row, event, err);
          }
        }),
      );
    } catch (err) {
      log.error("Dispatch error:", err);
    }
  });
}

// Stream consumer startup is handled by the notifications plugin
// (lib/plugins/notifications/register.ts). The legacy onEmit hook is
// registered as a fallback in case the plugin system isn't initialized.
onEmit("dispatch", dispatchToChannels);

// Re-export emit so call sites can import { emit } from "@/lib/notifications/dispatch"
// and get the dispatch hook registration as a side effect.
export { emit } from "@/lib/bus";
export type { BusEvent, BusEventType } from "@/lib/bus";
