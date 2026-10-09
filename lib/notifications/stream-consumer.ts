// Consumes org event streams and dispatches to notification channels. Failed deliveries stay pending and are reclaimed.

import { db } from "@/lib/db";
import {
  notificationChannels,
  notificationLogs,
  } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { consumeGroup } from "@/lib/stream/consumer";
import { eventStream } from "@/lib/stream/keys";
import type { StreamEntry } from "@/lib/stream/types";
import type { BusEvent, BusEventType } from "@/lib/bus/events";
import { createChannel } from "./factory";
import {
  fetchOrgMembers,
  fetchEventPrefs,
  resolveRecipients,
} from "./resolve-recipients";
import { isUiOnlyEvent } from "./ui-only";
import { markConsumedOrgs, clearConsumedOrgs } from "./consumer-state";
import { logger } from "@/lib/logger";

const log = logger.child("notifications-consumer");

const CONSUMER_GROUP = "notifications";
const CONSUMER_NAME = `notifications-${process.pid}`;

/** Parse a stream entry back into an orgId + BusEvent. */
function parseEventEntry(
  streamKey: string,
  entry: StreamEntry,
): { orgId: string; event: BusEvent } | null {
  try {
    // Stream key format: stream:events:{orgId}
    const orgId = streamKey.replace("stream:events:", "");
    const event = JSON.parse(entry.fields.payload) as BusEvent;
    return { orgId, event };
  } catch {
    log.warn(`Failed to parse event entry ${entry.id} from ${streamKey}`);
    return null;
  }
}

/** Check whether a channel's subscribedEvents filter allows this event. */
function channelAcceptsEvent(
  subscribedEvents: string[],
  eventType: BusEventType,
): boolean {
  if (subscribedEvents.length === 0) return true;
  return subscribedEvents.includes(eventType);
}

/** Dispatch a single event to all matching channels for an org. */
async function dispatchEvent(orgId: string, event: BusEvent): Promise<void> {
  if (isUiOnlyEvent(event)) return;

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

  const results = await Promise.allSettled(
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
        await logDelivery(orgId, row, event, "success");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(`Channel "${row.name}" failed: ${errorMsg}`);
        await logDelivery(orgId, row, event, "failed", errorMsg);
        throw err;
      }
    }),
  );

  // Throw on any failure so the entry isn't ACKed and is retried via XCLAIM.
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length} channel(s) failed delivery`);
  }
}

/** Best-effort delivery log. */
async function logDelivery(
  orgId: string,
  row: { id: string; name: string; type: string },
  event: BusEvent,
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
      eventType: event.type,
      eventTitle: event.title || event.type,
      status,
      error,
      attempt: 1,
    });
  } catch {
    // Don't let logging failures break dispatch
  }
}

let stopFn: (() => Promise<void>) | null = null;

/** Starts the consumer on every active org's event stream. New orgs need a restart. */
export async function startNotificationConsumer(): Promise<void> {
  if (stopFn) {
    log.warn("Notification consumer already running");
    return;
  }

  const orgs = await db.query.organizations.findMany({
    columns: { id: true },
  });

  if (orgs.length === 0) {
    log.info("No organizations found, notification consumer idle");
    return;
  }

  const streamKeys = orgs.map((org) => eventStream(org.id));

  log.info(`Starting notification consumer for ${streamKeys.length} org stream(s)`);

  // Must precede consumeGroup, or the direct hook double-sends.
  markConsumedOrgs(orgs.map((org) => org.id));

  try {
    stopFn = await consumeGroup({
      group: CONSUMER_GROUP,
      consumer: CONSUMER_NAME,
      keys: streamKeys,
      handler: async (streamKey, entry) => {
        const parsed = parseEventEntry(streamKey, entry);
        if (!parsed) return; // Skip unparseable entries (ACK them to move on)

        await dispatchEvent(parsed.orgId, parsed.event);
      },
    });
  } catch (err) {
    clearConsumedOrgs();
    throw err;
  }
}

/** Stops the consumer after in-progress deliveries drain. */
export async function stopNotificationConsumer(): Promise<void> {
  if (stopFn) {
    log.info("Stopping notification consumer...");
    await stopFn();
    stopFn = null;
    clearConsumedOrgs();
    log.info("Notification consumer stopped");
  }
}

/** Restarts the consumer to pick up new org streams. */
export async function restartNotificationConsumer(): Promise<void> {
  await stopNotificationConsumer();
  await startNotificationConsumer();
}
