// ---------------------------------------------------------------------------
// Redis Streams consumer — read and consume events
// ---------------------------------------------------------------------------

import Redis from "ioredis";
import { redis } from "@/lib/redis";
import type { StreamEntry, ReadStreamOptions, ConsumeGroupOptions } from "./types";
import { logger } from "@/lib/logger";
import { closeOnShutdown } from "@/lib/shutdown";

const log = logger.child("stream");

/** Batch size for XRANGE pagination during catchup. */
const CATCHUP_BATCH_SIZE = 200;

/** Backoff after a consumer loop error, doubling up to the cap. */
const CONSUMER_BACKOFF_MIN_MS = 1_000;
const CONSUMER_BACKOFF_MAX_MS = 60_000;
/** Consecutive loop errors before the consumer gives up instead of spinning. */
const CONSUMER_ERROR_LIMIT = 10;

/** A Redis stream ID: "<ms>-<seq>", or the "$"/">"/"0" specials. */
const STREAM_ID_RE = /^\d+-\d+$/;

export function isValidStreamId(id: string | null | undefined): boolean {
  if (!id) return false;
  return STREAM_ID_RE.test(id) || id === "0" || id === "$" || id === "0-0";
}

// ---------------------------------------------------------------------------
// Blocking reader connections
//
// XREAD BLOCK / XREADGROUP BLOCK hold the connection for up to blockMs.
// Using the shared `redis` client would block all other operations.
// Each blocking reader gets a dedicated connection from this pool.
// ---------------------------------------------------------------------------

/** Live blocking connections, each mapped to its shutdown unregister. */
const blockingClients = new Map<Redis, () => void>();

function getBlockingClient(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:7200";
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  // Registered per client, not at module scope — importing this module for its
  // helpers must not wire a shutdown for a pool that is never built.
  blockingClients.set(client, closeOnShutdown(() => releaseBlockingClient(client)));
  return client;
}

/** Disconnect a blocking client and drop it from the shutdown registry. */
function releaseBlockingClient(client: Redis): void {
  blockingClients.get(client)?.();
  blockingClients.delete(client);
  client.disconnect();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse raw ioredis XRANGE/XREAD result into StreamEntry[]. */
function parseEntries(raw: [string, string[]][]): StreamEntry[] {
  return raw.map(([id, fields]) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      record[fields[i]] = fields[i + 1];
    }
    return { id, fields: record };
  });
}

/**
 * Ensure a consumer group exists on a stream.
 * Uses MKSTREAM to create the stream if it doesn't exist.
 * Silently ignores "BUSYGROUP" (group already exists).
 */
async function ensureGroup(key: string, group: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", key, group, "0", "MKSTREAM");
    return;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
  }
  await repairGroupCursor(key, group);
}

/**
 * Reset a group whose persisted last-delivered-ID is not a valid stream ID.
 * Redis rejects every XREADGROUP against such a group, so the consumer can
 * never make progress — it just retries the same error forever.
 */
async function repairGroupCursor(key: string, group: string): Promise<void> {
  try {
    const groups = (await redis.xinfo("GROUPS", key)) as unknown[];
    for (const raw of groups) {
      if (!Array.isArray(raw)) continue;
      const fields: Record<string, string> = {};
      for (let i = 0; i < raw.length; i += 2) fields[String(raw[i])] = String(raw[i + 1]);
      if (fields.name !== group) continue;

      const cursor = fields["last-delivered-id"];
      if (isValidStreamId(cursor)) return;

      log.error(
        `Consumer group ${group} on ${key} has an invalid last-delivered-ID (${cursor}) — resetting to 0`,
      );
      await redis.xgroup("SETID", key, group, "0");
      return;
    }
  } catch (err) {
    log.warn(`Could not verify consumer group ${group} on ${key}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Read: history + live tail (for SSE gateway)
// ---------------------------------------------------------------------------

/**
 * Async generator that yields stream entries.
 *
 * 1. Reads existing entries from `fromId` via paginated XRANGE (catchup)
 * 2. Then live-tails via XREAD BLOCK on a dedicated connection (realtime)
 *
 * The consumer doesn't need to know which phase it's in — entries
 * arrive in order regardless.
 *
 * Stops when the signal is aborted or an error occurs.
 * Note: XREAD BLOCK cannot be interrupted mid-call — there is up to
 * `blockMs` latency between abort and actual stop.
 */
export async function* readStream(
  key: string,
  opts?: ReadStreamOptions,
): AsyncGenerator<StreamEntry> {
  const fromId = opts?.fromId ?? "0";
  const blockMs = opts?.blockMs ?? 2000; // Short block for responsive abort
  const signal = opts?.signal;

  // Phase 1: Catchup — paginated XRANGE to avoid unbounded memory.
  // "$" skips it entirely and live-tails from now.
  let cursor = fromId === "0" ? "-" : `(${fromId}`;
  let lastId: string | undefined;

  while (fromId !== "$" && !signal?.aborted) {
    const batch = await redis.xrange(
      key, cursor, "+", "COUNT", CATCHUP_BATCH_SIZE,
    ) as [string, string[]][] | null;

    if (!batch || batch.length === 0) break;

    for (const entry of parseEntries(batch)) {
      if (signal?.aborted) return;
      yield entry;
      lastId = entry.id;
    }

    if (batch.length < CATCHUP_BATCH_SIZE) break; // No more entries
    cursor = `(${lastId}`; // Exclusive start for next page
  }

  // Phase 2: Live tail — dedicated blocking connection
  const blockClient = getBlockingClient();
  const readCursor = lastId ?? (fromId === "0" ? "$" : fromId);
  let liveCursor = readCursor;

  try {
    while (!signal?.aborted) {
      try {
        const result = await blockClient.xread(
          "COUNT", 100,
          "BLOCK", blockMs,
          "STREAMS", key, liveCursor,
        ) as [string, [string, string[]][]][] | null;

        if (!result || signal?.aborted) continue;

        for (const [, entries] of result) {
          for (const entry of parseEntries(entries)) {
            if (signal?.aborted) return;
            yield entry;
            liveCursor = entry.id;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        log.error(`readStream error on ${key}:`, err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    releaseBlockingClient(blockClient);
  }
}

// ---------------------------------------------------------------------------
// Consumer group: at-least-once delivery for background processors
// ---------------------------------------------------------------------------

/**
 * Start a consumer group loop. Processes entries via the handler and ACKs on success.
 * Failed entries stay pending and will be reclaimed on restart.
 *
 * Returns a stop function. Call it to gracefully drain — it returns a Promise
 * that resolves when the consumer has finished processing and disconnected.
 */
export async function consumeGroup(opts: ConsumeGroupOptions): Promise<() => Promise<void>> {
  const { group, consumer, keys, handler, signal } = opts;
  const blockMs = opts.blockMs ?? 2000;
  const count = opts.count ?? 10;

  // Ensure groups exist on all keys
  for (const key of keys) {
    await ensureGroup(key, group);
  }

  const controller = new AbortController();
  const stopSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;

  // Dedicated blocking connection for XREADGROUP BLOCK
  const blockClient = getBlockingClient();

  // Run the consumer loop
  const loop = (async () => {
    try {
      // First, process any pending entries from a previous crash
      await processPending(keys, group, consumer, handler, stopSignal);

      // XREADGROUP takes every key first, then every ID — interleaving them
      // makes Redis read key 2 as an ID and reject the whole command.
      const streamArgs = [...keys, ...keys.map(() => ">")];
      let consecutiveErrors = 0;
      let backoffMs = CONSUMER_BACKOFF_MIN_MS;

      // Then read new entries
      while (!stopSignal.aborted) {
        try {
          const result = await blockClient.xreadgroup(
            "GROUP", group, consumer,
            "COUNT", count,
            "BLOCK", blockMs,
            "STREAMS", ...streamArgs,
          ) as [string, [string, string[]][]][] | null;

          consecutiveErrors = 0;
          backoffMs = CONSUMER_BACKOFF_MIN_MS;

          if (!result || stopSignal.aborted) continue;

          for (const [streamKey, entries] of result) {
            for (const entry of parseEntries(entries)) {
              if (stopSignal.aborted) return;
              try {
                await handler(streamKey, entry);
                await redis.xack(streamKey, group, entry.id);
              } catch (err) {
                log.warn(`Consumer ${group}/${consumer} failed on ${streamKey}:${entry.id}:`, err);
                // Don't ACK — entry stays pending for retry
              }
            }
          }
        } catch (err) {
          if (stopSignal.aborted) return;
          consecutiveErrors++;

          if (consecutiveErrors === 1) {
            log.error(`Consumer ${group}/${consumer} loop error:`, err);
          }
          if (consecutiveErrors >= CONSUMER_ERROR_LIMIT) {
            log.error(
              `Consumer ${group}/${consumer} failed ${consecutiveErrors} times in a row — stopping. Last error:`,
              err,
            );
            return;
          }

          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, CONSUMER_BACKOFF_MAX_MS);
        }
      }
    } finally {
      releaseBlockingClient(blockClient);
    }
  })();

  // Return stop function that awaits graceful drain
  return async () => {
    controller.abort();
    await loop;
  };
}

/** Process pending entries that weren't ACKed from a previous run. */
async function processPending(
  keys: string[],
  group: string,
  consumer: string,
  handler: (key: string, entry: StreamEntry) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    if (signal.aborted) return;
    try {
      // Claim entries idle for > 30s
      const pending = await redis.xpending(key, group, "-", "+", 100);
      if (!pending || !Array.isArray(pending)) continue;

      for (const entry of pending as [string, string, number, number][]) {
        if (signal.aborted) return;
        const [entryId, , idleMs] = entry;
        if (idleMs < 30_000) continue;

        const claimed = await redis.xclaim(
          key, group, consumer, 30_000, entryId,
        );
        if (!claimed || !Array.isArray(claimed)) continue;

        for (const raw of claimed as [string, string[]][]) {
          const parsed = parseEntries([raw])[0];
          try {
            await handler(key, parsed);
            await redis.xack(key, group, parsed.id);
          } catch (err) {
            log.warn(`Pending entry ${key}:${parsed.id} failed again:`, err);
          }
        }
      }
    } catch (err) {
      log.warn(`processPending error on ${key}:`, err);
    }
  }
}

/** Merge two AbortSignals — aborts when either fires. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) { controller.abort(); return controller.signal; }
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
