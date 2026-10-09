import { redis } from "@/lib/redis";

const RUNNING_TTL_SECONDS = 6 * 60 * 60;
const COOLDOWN_TTL_SECONDS = 15 * 60;

const key = (appId: string) => `vardo:bulk-write:${appId}`;

/** Marks an app as bulk-loading until the run ends, then for 15 minutes. Redis errors never fail the run. */
export async function withBulkWrite<T>(appId: string | null | undefined, run: () => Promise<T>): Promise<T> {
  if (!appId) return run();
  await redis.set(key(appId), "1", "EX", RUNNING_TTL_SECONDS).catch(() => {});
  try {
    return await run();
  } finally {
    await redis.set(key(appId), "1", "EX", COOLDOWN_TTL_SECONDS).catch(() => {});
  }
}

/** Whether any of the apps is mid-import or restore, or finished one within 15 minutes. */
export async function isBulkWriting(appIds: Array<string | null | undefined>): Promise<boolean> {
  const ids = appIds.filter((id): id is string => !!id);
  if (ids.length === 0) return false;
  try {
    return (await redis.exists(...ids.map(key))) > 0;
  } catch {
    return false;
  }
}
