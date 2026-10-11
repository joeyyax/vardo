// Probe hit counting in Redis: a sliding window per address and daily totals per app.

import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";

const WINDOW_KEY = (ip: string) => `probe-guard:window:${ip}`;
const DAY_KEY = (scope: string, day: string) => `probe-guard:hits:${scope}:${day}`;
const ALL = "_all";
const DAY_TTL_S = 9 * 86_400;

export function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Records one hit and returns how many the address has within the window. */
export async function recordHit(ip: string, appId: string | null, windowMs: number, now = Date.now()): Promise<number> {
  const key = WINDOW_KEY(ip);
  const day = dayStamp(new Date(now));
  const tx = redis.multi();
  tx.zremrangebyscore(key, 0, now - windowMs);
  tx.zadd(key, now, `${now}:${randomUUID().slice(0, 8)}`);
  tx.zcard(key);
  tx.pexpire(key, windowMs);
  tx.incr(DAY_KEY(ALL, day));
  tx.expire(DAY_KEY(ALL, day), DAY_TTL_S);
  if (appId) {
    tx.incr(DAY_KEY(appId, day));
    tx.expire(DAY_KEY(appId, day), DAY_TTL_S);
  }
  const results = await tx.exec();
  const card = results?.[2]?.[1];
  return typeof card === "number" ? card : 0;
}

/** Clears an address's window, after a ban or an unban. */
export async function clearWindow(ip: string): Promise<void> {
  await redis.del(WINDOW_KEY(ip));
}

/** Turned-away probes over the last seven days, today included. */
export async function hitsThisWeek(appId: string | null, now = new Date()): Promise<number> {
  const keys = Array.from({ length: 7 }, (_, i) => DAY_KEY(appId ?? ALL, dayStamp(new Date(now.getTime() - i * 86_400_000))));
  const values = await redis.mget(...keys);
  return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
}
