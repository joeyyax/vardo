// ---------------------------------------------------------------------------
// Redis Streams consumer — read and consume events
// ---------------------------------------------------------------------------

import Redis from "ioredis";
import { redis } from "@/lib/redis";
import type { StreamEntry, ReadStreamOptions, ConsumeGroupOptions } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child("stream");

/** Batch size for XRANGE pagination during catchup. */
const CATCHUP_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Blocking reader connections
//
// XREAD BLOCK / XREADGROUP BLOCK hold the connection for up to blockMs.
// Using the shared `redis` client would block all other operations.
// Each blocking reader gets a dedicated connection from this pool.
// ---------------------------------------------------------------------------

const blockingClients: Redis[] = [];

function getBlockingClient(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:7200";
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  blockingClients.push(client);
  return client;
}

// Cleanup on shutdown
function cleanupBlockingClients() {
  for (const client of blockingClients) {
    client.disconnect();
  }
  blockingClients.length = 0;
}
process.once("SIGTERM", cleanupBlockingClients);
process.once("SIGINT", cleanupBlockingClients);

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
  } catch (err) {
    if (err instanceof Error && err.message.includes("BUSYGROUP")) return;
    throw err;
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

  // Phase 1: Catchup — paginated XRANGE to avoid unbounded memory
  let cursor = fromId === "0" ? "-" : `(${fromId}`;
  let lastId: string | undefined;

  while (!signal?.aborted) {
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
    blockClient.disconnect();
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

      // Then read new entries
      while (!stopSignal.aborted) {
        try {
          const streamArgs = keys.flatMap((k) => [k, ">"]);
          const result = await blockClient.xreadgroup(
            "GROUP", group, consumer,
            "COUNT", count,
            "BLOCK", blockMs,
            "STREAMS", ...streamArgs,
          ) as [string, [string, string[]][]][] | null;

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
          log.error(`Consumer ${group}/${consumer} loop error:`, err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } finally {
      blockClient.disconnect();
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
