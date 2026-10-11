// The abuse report queue in Redis: one pending entry per address, a 15-minute dedupe and a daily count.

import type Redis from "ioredis";
import { normalizeIp } from "../ban-policy";

export const QUEUE_KEY = "abuse-report:queue";
const SENT_KEY = (ip: string) => `abuse-report:sent:${ip}`;
const DAY_KEY = (day: string) => `abuse-report:day:${day}`;

/** AbuseIPDB takes one report per address per 15 minutes. */
export const DEDUPE_MS = 15 * 60_000;
/** Wait before sending, so a ban's later hits make the report. */
export const SETTLE_MS = 60_000;
/** Entries older than this are dropped unsent. */
export const STALE_MS = 6 * 3_600_000;
const DAY_TTL_S = 2 * 86_400;

export interface ReportQueueStore {
  /** Adds an address unless it's already pending. */
  enqueue(ip: string, dueAt: number): Promise<boolean>;
  due(now: number, limit: number): Promise<string[]>;
  /** Claims an entry. False when another pass took it. */
  remove(ip: string): Promise<boolean>;
  requeue(ip: string, dueAt: number): Promise<void>;
  dropBefore(at: number): Promise<void>;
  recentlyReported(ip: string): Promise<boolean>;
  markReported(ip: string, ttlMs: number): Promise<void>;
  /** Takes one of the day's reports. False when the cap is reached. */
  reserveDaily(day: string, cap: number): Promise<boolean>;
  releaseDaily(day: string): Promise<void>;
  dailyCount(day: string): Promise<number>;
}

type QueueClient = Pick<Redis, "zadd" | "zrangebyscore" | "zrem" | "zremrangebyscore" | "exists" | "set" | "incr" | "decr" | "expire" | "get">;

export function redisReportStore(client: QueueClient): ReportQueueStore {
  return {
    async enqueue(ip, dueAt) {
      // Due time is the queued-at time plus SETTLE_MS, so staleness counts from it.
      return (await client.zadd(QUEUE_KEY, "NX", dueAt, ip)) === 1;
    },
    async due(now, limit) {
      return client.zrangebyscore(QUEUE_KEY, "-inf", now, "LIMIT", 0, limit);
    },
    async remove(ip) {
      return (await client.zrem(QUEUE_KEY, ip)) === 1;
    },
    async requeue(ip, dueAt) {
      await client.zadd(QUEUE_KEY, dueAt, ip);
    },
    async dropBefore(at) {
      await client.zremrangebyscore(QUEUE_KEY, "-inf", at);
    },
    async recentlyReported(ip) {
      return (await client.exists(SENT_KEY(ip))) === 1;
    },
    async markReported(ip, ttlMs) {
      await client.set(SENT_KEY(ip), "1", "PX", ttlMs);
    },
    async reserveDaily(day, cap) {
      const n = await client.incr(DAY_KEY(day));
      if (n === 1) await client.expire(DAY_KEY(day), DAY_TTL_S);
      if (n > cap) {
        await client.decr(DAY_KEY(day));
        return false;
      }
      return true;
    },
    async releaseDaily(day) {
      await client.decr(DAY_KEY(day));
    },
    async dailyCount(day) {
      return Number(await client.get(DAY_KEY(day))) || 0;
    },
  };
}

export function reportDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export type QueueDeps = {
  store: ReportQueueStore;
  /** Reporting is on and a key is set. */
  enabled: () => Promise<boolean>;
  now?: () => number;
};

/** Queues an address for the reporter loop. Eligibility is decided when it's sent. */
export async function queueReport(rawIp: string, deps: QueueDeps): Promise<boolean> {
  const ip = normalizeIp(rawIp);
  if (!ip || !(await deps.enabled())) return false;
  if (await deps.store.recentlyReported(ip)) return false;
  return deps.store.enqueue(ip, (deps.now ?? Date.now)() + SETTLE_MS);
}

let defaultStore: ReportQueueStore | null = null;

export async function defaultReportStore(): Promise<ReportQueueStore> {
  if (!defaultStore) {
    const { redis } = await import("@/lib/redis");
    defaultStore = redisReportStore(redis);
  }
  return defaultStore;
}

/** Queues an address with the instance's settings. Never waits on the reporter. */
export async function queueAbuseReport(ip: string): Promise<boolean> {
  const { getAbuseApiKey, getAbuseSettings } = await import("../abuse-store");
  return queueReport(ip, {
    store: await defaultReportStore(),
    enabled: async () => (await getAbuseSettings()).reporting.enabled && !!(await getAbuseApiKey()),
  });
}
