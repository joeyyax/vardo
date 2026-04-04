/**
 * Notification retry via Redis list.
 *
 * When a channel send fails, the delivery is pushed to a Redis list
 * with attempt count and backoff timestamp. A tick function processes
 * the list every 30s, retrying deliveries that are past their backoff.
 *
 * After 3 failed attempts the notification is abandoned and logged
 * as permanently failed.
 */

import { redis } from "@/lib/redis";
import { acquireLock } from "@/lib/redis-lock";
import { db } from "@/lib/db";
import { notificationChannels, notificationLogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createChannel } from "./factory";
import type { BusEvent } from "@/lib/bus";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

const RETRY_KEY = "vardo:notification:retry";
const MAX_ATTEMPTS = 3;
const MAX_QUEUE_LENGTH = 500; // circuit breaker - drop oldest if exceeded
const BACKOFF_MS = [0, 5_000, 15_000]; // immediate, 5s, 15s

type RetryEntry = {
  orgId: string;
  channelId: string;
  channelName: string;
  channelType: string;
  event: BusEvent;
  attempt: number;
  retryAfter: number; // timestamp ms
};

/**
 * Enqueue a failed notification for retry.
 */
export async function enqueueRetry(entry: Omit<RetryEntry, "attempt" | "retryAfter">, attempt: number): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) return; // exhausted

  const delay = BACKOFF_MS[attempt] ?? 15_000;
  const retryEntry: RetryEntry = {
    ...entry,
    attempt: attempt + 1,
    retryAfter: Date.now() + delay,
  };

  await redis.lpush(RETRY_KEY, JSON.stringify(retryEntry));
  // Circuit breaker - trim to cap if the queue is growing unboundedly
  await redis.ltrim(RETRY_KEY, 0, MAX_QUEUE_LENGTH - 1);
}

/**
 * Process the retry queue. Call every 30s from the scheduler.
 * Pops entries that are past their backoff time and retries them.
 */
export async function tickNotificationRetries(): Promise<void> {
  const len = await redis.llen(RETRY_KEY);
  if (len === 0) return;

  // Distributed lock - prevents multiple workers processing the same entries
  const locked = await acquireLock("lock:notification-retry", 30_000);
  if (!locked) return;

  const now = Date.now();
  const requeue: string[] = [];

  // Pop all entries
  const entries: string[] = [];
  for (let i = 0; i < len; i++) {
    const raw = await redis.rpop(RETRY_KEY);
    if (raw) entries.push(raw);
  }

  for (const raw of entries) {
    let entry: RetryEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue; // corrupt entry, discard
    }

    // Not ready yet - put it back
    if (now < entry.retryAfter) {
      requeue.push(raw);
      continue;
    }

    // Fetch channel config (may have changed or been deleted)
    const channel = await db.query.notificationChannels.findFirst({
      where: eq(notificationChannels.id, entry.channelId),
    });

    if (!channel || !channel.enabled) {
      // Channel gone or disabled - log and skip
      await logAttempt(entry, "failed", "Channel deleted or disabled");
      continue;
    }

    // Retry the send
    try {
      await createChannel(channel).send(entry.event);
      await logAttempt(entry, "success", null);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      if (entry.attempt >= MAX_ATTEMPTS) {
        // Exhausted all retries
        log.error(
          `Channel "${entry.channelName}" permanently failed after ${entry.attempt} attempts:`,
          error
        );
        await logAttempt(entry, "failed", error);
      } else {
        // Re-enqueue for another retry
        log.warn(
          `Channel "${entry.channelName}" attempt ${entry.attempt}/${MAX_ATTEMPTS} failed, will retry`
        );
        await enqueueRetry(entry, entry.attempt);
      }
    }
  }

  // Put back entries that weren't ready
  if (requeue.length > 0) {
    await redis.lpush(RETRY_KEY, ...requeue);
  }
}

async function logAttempt(entry: RetryEntry, status: string, error: string | null): Promise<void> {
  try {
    await db.insert(notificationLogs).values({
      id: nanoid(),
      organizationId: entry.orgId,
      channelId: entry.channelId,
      channelName: entry.channelName,
      channelType: entry.channelType,
      eventType: entry.event.type,
      eventTitle: (entry.event as Record<string, unknown>).title as string || entry.event.type,
      status,
      error,
      attempt: entry.attempt,
    });
  } catch {
    // Don't crash the retry loop
  }
}
