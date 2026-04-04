// ---------------------------------------------------------------------------
// Redis Streams consumer — read and consume events
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type { StreamEntry, ReadStreamOptions, ConsumeGroupOptions } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child("stream");

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
 * 1. Reads all existing entries from `fromId` via XRANGE (catchup)
 * 2. Then live-tails via XREAD BLOCK (realtime)
 *
 * The consumer doesn't need to know which phase it's in — entries
 * arrive in order regardless.
 *
 * Stops when the signal is aborted or an error occurs.
 */
export async function* readStream(
  key: string,
  opts?: ReadStreamOptions,
): AsyncGenerator<StreamEntry> {
  const fromId = opts?.fromId ?? "0";
  const blockMs = opts?.blockMs ?? 5000;
  const signal = opts?.signal;

  // Phase 1: Catchup — read all existing entries
  const existing = await redis.xrange(key, fromId === "0" ? "-" : `(${fromId}`, "+");
  if (existing) {
    for (const entry of parseEntries(existing as [string, string[]][])) {
      if (signal?.aborted) return;
      yield entry;
    }
  }

  // Phase 2: Live tail — block-read for new entries
  let lastId = existing && existing.length > 0
    ? (existing[existing.length - 1] as [string, string[]])[0]
    : fromId === "0" ? "$" : fromId;

  while (!signal?.aborted) {
    try {
      const result = await redis.xread(
        "COUNT", 100,
        "BLOCK", blockMs,
        "STREAMS", key, lastId,
      ) as [string, [string, string[]][]][] | null;

      if (!result || signal?.aborted) continue;

      // result is [[streamKey, entries], ...]
      for (const [, entries] of result as [string, [string, string[]][]][]) {
        for (const entry of parseEntries(entries)) {
          if (signal?.aborted) return;
          yield entry;
          lastId = entry.id;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      log.error(`readStream error on ${key}:`, err);
      // Brief pause before retry to avoid tight error loops
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Consumer group: at-least-once delivery for background processors
// ---------------------------------------------------------------------------

/**
 * Start a consumer group loop. Processes entries via the handler and ACKs on success.
 * Failed entries stay pending and will be reclaimed on restart.
 *
 * Returns a stop function that gracefully drains the consumer.
 */
export async function consumeGroup(opts: ConsumeGroupOptions): Promise<() => void> {
  const { group, consumer, keys, handler, signal } = opts;
  const blockMs = opts.blockMs ?? 5000;
  const count = opts.count ?? 10;

  // Ensure groups exist on all keys
  for (const key of keys) {
    await ensureGroup(key, group);
  }

  const controller = new AbortController();
  const stopSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;

  // Run the consumer loop
  const loop = (async () => {
    // First, process any pending entries from a previous crash
    await processPending(keys, group, consumer, handler, stopSignal);

    // Then read new entries
    while (!stopSignal.aborted) {
      try {
        const streamArgs = keys.flatMap((k) => [k, ">"]);
        const result = await redis.xreadgroup(
          "GROUP", group, consumer,
          "COUNT", count,
          "BLOCK", blockMs,
          "STREAMS", ...streamArgs,
        ) as [string, [string, string[]][]][] | null;

        if (!result || stopSignal.aborted) continue;

        for (const [streamKey, entries] of result as [string, [string, string[]][]][]) {
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
  })();

  // Return stop function
  return () => {
    controller.abort();
    return loop;
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
