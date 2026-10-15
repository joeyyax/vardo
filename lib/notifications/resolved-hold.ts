// Resolutions held per org in Redis, so alerts that clear close together reach email and push as one notice.

import type Redis from "ioredis";
import { redis } from "@/lib/redis";
import type { AlertResolvedEvent, BusEvent } from "@/lib/bus/events";
import { logger } from "@/lib/logger";
import { emit, emitConfirmed } from "./dispatch";
import { sortAlerts } from "./registry";

const log = logger.child("notifications");

export type ResolvedItem = AlertResolvedEvent["alerts"][number];

/** Sends once nothing new has cleared for this long. */
export const RESOLVED_QUIET_MS = 3 * 60_000;
/** Sends at the latest this long after the first held clear. */
export const RESOLVED_MAX_MS = 15 * 60_000;

/** The resolved notice for these items, worst first. */
export function resolvedNotice(items: ResolvedItem[], flags: Pick<AlertResolvedEvent, "quiet" | "held" | "grouped"> = {}): BusEvent {
  const alerts = sortAlerts(items);
  return {
    type: "alert.resolved",
    title: alerts.length === 1 ? `Resolved: ${alerts[0].title}` : `${alerts.length} alerts resolved`,
    message: alerts.map((a) => a.title).join("; "),
    alerts,
    ...(alerts.length === 1 && alerts[0].incident ? { incident: alerts[0].incident } : {}),
    ...flags,
  };
}

// Takes the org's held items when due, atomically. Nil while it waits, empty when nothing's held.
const TAKE = `
if redis.call('LLEN', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('SREM', KEYS[3], ARGV[1])
  return {}
end
if ARGV[5] ~= '1' then
  local now = tonumber(ARGV[2])
  local first = tonumber(redis.call('HGET', KEYS[2], 'first') or '0')
  local last = tonumber(redis.call('HGET', KEYS[2], 'last') or '0')
  if now - last < tonumber(ARGV[3]) and now - first < tonumber(ARGV[4]) then return false end
end
local held = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
return held
`;

/** Held items per org: a list of items, a hash with the first and last hold times, and a set of orgs holding any. */
export function resolvedHoldStore(client: Redis = redis, prefix = "notifications:resolved") {
  const orgsKey = `${prefix}:orgs`;
  const itemsKey = (orgId: string) => `${prefix}:items:${orgId}`;
  const metaKey = (orgId: string) => `${prefix}:meta:${orgId}`;

  return {
    async hold(orgId: string, items: ResolvedItem[], now: number): Promise<void> {
      const results = await client
        .multi()
        .rpush(itemsKey(orgId), ...items.map((item) => JSON.stringify(item)))
        .hsetnx(metaKey(orgId), "first", String(now))
        .hset(metaKey(orgId), "last", String(now))
        .sadd(orgsKey, orgId)
        .exec();
      const failed = results?.find(([err]) => err)?.[0];
      if (!results || failed) throw failed ?? new Error("Hold transaction aborted");
    },

    orgs(): Promise<string[]> {
      return client.smembers(orgsKey);
    },

    /** The org's held items once due, or at once when forced. Null while it waits. */
    async take(orgId: string, now: number, force = false): Promise<ResolvedItem[] | null> {
      const raw = (await client.eval(
        TAKE,
        3,
        itemsKey(orgId),
        metaKey(orgId),
        orgsKey,
        orgId,
        String(now),
        String(RESOLVED_QUIET_MS),
        String(RESOLVED_MAX_MS),
        force ? "1" : "0",
      )) as string[] | null;
      if (raw === null) return null;
      return raw.flatMap((entry) => {
        try {
          return [JSON.parse(entry) as ResolvedItem];
        } catch {
          return [];
        }
      });
    },
  };
}

export type ResolvedHoldStore = ReturnType<typeof resolvedHoldStore>;

const defaultStore = resolvedHoldStore();

/** Holds resolutions for the org's grouped notice. Sends them at once when Redis can't hold them. */
export async function holdResolved(orgId: string, items: ResolvedItem[], now: Date, store: ResolvedHoldStore = defaultStore): Promise<void> {
  if (items.length === 0) return;
  try {
    await store.hold(orgId, items, now.getTime());
  } catch (err) {
    log.warn(`Couldn't hold ${items.length} resolved alert(s) for org ${orgId}, sending now:`, err);
    emit(orgId, resolvedNotice(items, { grouped: true }));
  }
}

/** Sends the org's held resolutions as one notice once due, or at once when forced. Returns whether it sent. */
export async function sendHeldResolved(orgId: string, now: number, force = false, store: ResolvedHoldStore = defaultStore): Promise<boolean> {
  let items: ResolvedItem[] | null;
  try {
    items = await store.take(orgId, now, force);
  } catch (err) {
    log.warn(`Couldn't read held resolved alerts for org ${orgId}:`, err);
    return false;
  }
  if (!items || items.length === 0) return false;

  try {
    await emitConfirmed(orgId, resolvedNotice(items, { grouped: true }));
    return true;
  } catch (err) {
    log.warn(`Resolved notice for org ${orgId} failed, holding it again:`, err);
  }
  try {
    await store.hold(orgId, items, now);
  } catch {
    log.error(`Dropped ${items.length} resolved alert(s) for org ${orgId}: ${items.map((i) => i.title).join("; ")}`);
  }
  return false;
}

/** Sends every org's due resolutions. Returns how many notices went out. */
export async function flushResolved(now = Date.now(), store: ResolvedHoldStore = defaultStore): Promise<number> {
  let sent = 0;
  for (const orgId of await store.orgs()) {
    if (await sendHeldResolved(orgId, now, false, store)) sent++;
  }
  return sent;
}
