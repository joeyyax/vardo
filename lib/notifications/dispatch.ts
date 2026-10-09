import { db } from "@/lib/db";
import { notificationChannels, notificationLogs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createChannel } from "./factory";
import { enqueueRetry } from "./retry";
import { onEmit } from "@/lib/bus";
import type { BusEvent, BusEventType } from "@/lib/bus";
import { logger } from "@/lib/logger";
import { fetchOrgMembers, fetchEventPrefs, resolveRecipients } from "./resolve-recipients";
import { isUiOnlyEvent } from "./ui-only";
import { isConsumedOrg } from "./consumer-state";
import type { DeliveryReceipt } from "./port";

const log = logger.child("notifications");

/** Whether a channel's subscribedEvents filter allows this event. Empty means all. */
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
  receipt?: DeliveryReceipt | void,
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
      providerMessageIds: receipt?.providerMessageIds ?? null,
    });
  } catch {
    // Best-effort.
  }
}

/** Enqueues a retry for a failed send, or logs it when enqueueing fails. */
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
    await logNotification(orgId, row, event.type, event.title, "failed", errorMsg);
  }
}

/** Dispatches a bus event to an org's matching notification channels. */
function dispatchToChannels(orgId: string, event: BusEvent): void {
  if (isUiOnlyEvent(event)) return;
  if (isConsumedOrg(orgId)) return;

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
            const receipt = await createChannel(row).send(event);
            await logNotification(orgId, row, event.type, event.title, "success", receipt?.partialFailure, receipt);
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

// Delivers for orgs the stream consumer isn't reading.
onEmit("dispatch", dispatchToChannels);

// Import emit from here so the dispatch hook registers as a side effect.
export { emit } from "@/lib/bus";
export type { BusEvent, BusEventType } from "@/lib/bus";
