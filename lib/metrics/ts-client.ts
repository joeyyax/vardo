import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:7200";

// Dedicated connection for time-series operations.
const globalForTS = globalThis as unknown as { tsRedis: Redis | undefined };

export function getTsClient(): Redis {
  if (!globalForTS.tsRedis) {
    globalForTS.tsRedis = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      // RESP3 reshapes TS.MGET/TS.MRANGE replies; the parsers expect RESP2.
      protocol: 2,
    });
  }
  return globalForTS.tsRedis;
}

export const tsRedis = new Proxy({} as Redis, {
  get(_, prop: string | symbol) {
    const client = getTsClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(client);
    }
    return value;
  },
});

// Seven days.
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// metrics:{projectName}:{metric}:{containerId}
export function tsKey(project: string, metric: string, container?: string) {
  return container
    ? `metrics:${project}:${metric}:${container}`
    : `metrics:${project}:${metric}`;
}

// Keys already created in this process.
const createdKeys = new Set<string>();

/** Ensures a time-series key exists with retention and labels, adding labels to older keys. */
export async function ensureTimeSeries(
  key: string,
  labels: Record<string, string>
) {
  if (createdKeys.has(key)) return;

  const labelArgs = Object.entries(labels).flat();

  try {
    await tsRedis.call(
      "TS.CREATE",
      key,
      "RETENTION",
      RETENTION_MS.toString(),
      "DUPLICATE_POLICY",
      "LAST",
      "LABELS",
      ...labelArgs
    );
  } catch (err: unknown) {
    if (err instanceof Error && !err.message.includes("already exists")) {
      throw err;
    }
    try {
      await tsRedis.call("TS.ALTER", key, "LABELS", ...labelArgs);
    } catch {
      // Best-effort; a stale label set still serves existing queries.
    }
  }

  createdKeys.add(key);
}

/** Refreshes a series' key TTL to the retention window. Call after every write. */
export async function touchRetention(key: string): Promise<void> {
  await tsRedis.call("PEXPIRE", key, RETENTION_MS.toString());
}

/** Drops a key from the created-keys cache after deleting it out of band. */
export function forgetKey(key: string): void {
  createdKeys.delete(key);
}
