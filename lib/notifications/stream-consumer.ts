// ---------------------------------------------------------------------------
// Notification stream consumer
//
// Replaces the in-process onEmit hook + Redis list retry queue with a
// Redis Streams consumer group. Each event is processed exactly once
// (at-least-once with dedup via ACK). Failed deliveries stay as pending
// entries and are automatically reclaimed on restart.
//
// This module is the bridge between the event bus and notification channels.
// It consumes from all org event streams and dispatches to email/webhook/slack.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  notificationChannels,
  notificationLogs,
  organizations,
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
        await logDelivery(orgId, row, event, "success");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.warn(`Channel "${row.name}" failed: ${errorMsg}`);
        await logDelivery(orgId, row, event, "failed", errorMsg);
        // Throw so the consumer group doesn't ACK — entry stays pending for retry
        throw err;
      }
    }),
  );
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

// ---------------------------------------------------------------------------
// Consumer lifecycle
// ---------------------------------------------------------------------------

let stopFn: (() => Promise<void>) | null = null;

/**
 * Start the notification stream consumer.
 *
 * Queries all active orgs and subscribes to their event streams.
 * New orgs created after startup will need a restart or dynamic
 * stream addition (future improvement).
 */
export async function startNotificationConsumer(): Promise<void> {
  if (stopFn) {
    log.warn("Notification consumer already running");
    return;
  }

  // Get all active org IDs to subscribe to their event streams
  const orgs = await db.query.organizations.findMany({
    columns: { id: true },
  });

  if (orgs.length === 0) {
    log.info("No organizations found, notification consumer idle");
    return;
  }

  const streamKeys = orgs.map((org) => eventStream(org.id));

  log.info(`Starting notification consumer for ${streamKeys.length} org stream(s)`);

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
}

/**
 * Stop the notification consumer gracefully.
 * Awaits drain of in-progress deliveries.
 */
export async function stopNotificationConsumer(): Promise<void> {
  if (stopFn) {
    log.info("Stopping notification consumer...");
    await stopFn();
    stopFn = null;
    log.info("Notification consumer stopped");
  }
}
