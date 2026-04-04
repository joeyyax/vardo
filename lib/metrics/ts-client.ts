import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:7200";

// Dedicated connection for time-series operations
const globalForTS = globalThis as unknown as { tsRedis: Redis | undefined };

export function getTsClient(): Redis {
  if (!globalForTS.tsRedis) {
    globalForTS.tsRedis = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
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

// Retention: 7 days in ms
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Key naming: metrics:{projectName}:{metric}:{containerId}
export function tsKey(project: string, metric: string, container?: string) {
  return container
    ? `metrics:${project}:${metric}:${container}`
    : `metrics:${project}:${metric}`;
}

// Track which time-series keys have already been created to skip redundant TS.CREATE calls
const createdKeys = new Set<string>();

/**
 * Ensure a time-series key exists with the correct retention and labels.
 * Skips the TS.CREATE call if the key was already created in this process.
 */
export async function ensureTimeSeries(
  key: string,
  labels: Record<string, string>
) {
  if (createdKeys.has(key)) return;

  try {
    const labelArgs = Object.entries(labels).flat();
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
    // Key already exists -- that's fine
    if (err instanceof Error && !err.message.includes("already exists")) {
      throw err;
    }
  }

  createdKeys.add(key);
}
