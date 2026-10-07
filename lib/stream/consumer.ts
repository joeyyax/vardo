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
/** Consecutive loop errors before the consumer gives up. */
const CONSUMER_ERROR_LIMIT = 10;

/** A Redis stream ID: "<ms>-<seq>", or the "$"/">"/"0" specials. */
const STREAM_ID_RE = /^\d+-\d+$/;

export function isValidStreamId(id: string | null | undefined): boolean {
  if (!id) return false;
  return STREAM_ID_RE.test(id) || id === "0" || id === "$" || id === "0-0";
}

// Blocking reads hold their connection for blockMs, so each reader gets a dedicated one.

/** Live blocking connections, each mapped to its shutdown unregister. */
const blockingClients = new Map<Redis, () => void>();

function getBlockingClient(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:7200";
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  // Registered per client so importing the helpers doesn't wire a shutdown.
  blockingClients.set(client, closeOnShutdown(() => releaseBlockingClient(client)));
  return client;
}

/** Disconnects a blocking client and drops it from the shutdown registry. */
function releaseBlockingClient(client: Redis): void {
  blockingClients.get(client)?.();
  blockingClients.delete(client);
  client.disconnect();
}

/** Parses an ioredis XRANGE/XREAD result into StreamEntry[]. */
function parseEntries(raw: [string, string[]][]): StreamEntry[] {
  return raw.map(([id, fields]) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      record[fields[i]] = fields[i + 1];
    }
    return { id, fields: record };
  });
}

/** Ensures a consumer group exists, creating the stream if needed. Ignores BUSYGROUP. */
async function ensureGroup(key: string, group: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", key, group, "0", "MKSTREAM");
    return;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
  }
  await repairGroupCursor(key, group);
}

/** Resets a group whose last-delivered-ID is invalid; Redis rejects every XREADGROUP against it. */
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

/**
 * Yields stream entries: paginated XRANGE catchup from `fromId`, then XREAD BLOCK live tail.
 * XREAD BLOCK can't be interrupted, so stopping lags abort by up to `blockMs`.
 */
export async function* readStream(
  key: string,
  opts?: ReadStreamOptions,
): AsyncGenerator<StreamEntry> {
  const fromId = opts?.fromId ?? "0";
  const blockMs = opts?.blockMs ?? 2000;
  const signal = opts?.signal;

  // Catchup, paginated. "$" skips it and live-tails from now.
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

    if (batch.length < CATCHUP_BATCH_SIZE) break;
    cursor = `(${lastId}`;
  }

  // Live tail.
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

/**
 * Starts a consumer group loop with at-least-once delivery, ACKing on success.
 * Returns a stop function that resolves once the consumer drains and disconnects.
 */
export async function consumeGroup(opts: ConsumeGroupOptions): Promise<() => Promise<void>> {
  const { group, consumer, keys, handler, signal } = opts;
  const blockMs = opts.blockMs ?? 2000;
  const count = opts.count ?? 10;

  for (const key of keys) {
    await ensureGroup(key, group);
  }

  const controller = new AbortController();
  const stopSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;

  const blockClient = getBlockingClient();

  const loop = (async () => {
    try {
      // Pending entries from a previous crash first.
      await processPending(keys, group, consumer, handler, stopSignal);

      // XREADGROUP takes every key, then every ID. Interleaving them breaks the command.
      const streamArgs = [...keys, ...keys.map(() => ">")];
      let consecutiveErrors = 0;
      let backoffMs = CONSUMER_BACKOFF_MIN_MS;

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
                // No ACK; the entry stays pending for retry.
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

  return async () => {
    controller.abort();
    await loop;
  };
}

/** Processes entries left unACKed by a previous run. */
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
      // Claim entries idle for over 30s.
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

/** Merges two AbortSignals. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) { controller.abort(); return controller.signal; }
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
