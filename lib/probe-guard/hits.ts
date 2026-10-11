// Probe hit counting in Redis: a sliding window per address, and hourly and daily totals per app.

import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";
import { OTHER_RULE_ID } from "./rules";

const WINDOW_KEY = (ip: string) => `probe-guard:window:${ip}`;
const DAY_KEY = (scope: string, day: string) => `probe-guard:hits:${scope}:${day}`;
const HOUR_KEY = (scope: string, hour: string) => `probe-guard:hits-hour:${scope}:${hour}`;
const RULE_DAY_KEY = (scope: string, day: string) => `probe-guard:rule-hits:${scope}:${day}`;
const RULE_HOUR_KEY = (scope: string, hour: string) => `probe-guard:rule-hits-hour:${scope}:${hour}`;
/** Epoch ms of the first rule-counted hit. */
export const RULE_SINCE_KEY = "probe-guard:rule-hits:since";
const ALL = "_all";
/** Past the 90-day retention, so every range has its counts. */
export const DAY_TTL_S = 92 * 86_400;
export const HOUR_TTL_S = 50 * 3_600;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function hourStamp(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/** Records one hit, and the rule it tripped, and returns how many the address has within the window. */
export async function recordHit(
  ip: string,
  appId: string | null,
  windowMs: number,
  ruleId: string = OTHER_RULE_ID,
  now = Date.now(),
): Promise<number> {
  const key = WINDOW_KEY(ip);
  const day = dayStamp(new Date(now));
  const hour = hourStamp(new Date(now));
  const tx = redis.multi();
  tx.zremrangebyscore(key, 0, now - windowMs);
  tx.zadd(key, now, `${now}:${randomUUID().slice(0, 8)}`);
  tx.zcard(key);
  tx.pexpire(key, windowMs);
  for (const scope of appId ? [ALL, appId] : [ALL]) {
    tx.incr(DAY_KEY(scope, day));
    tx.expire(DAY_KEY(scope, day), DAY_TTL_S);
    tx.incr(HOUR_KEY(scope, hour));
    tx.expire(HOUR_KEY(scope, hour), HOUR_TTL_S);
    tx.hincrby(RULE_DAY_KEY(scope, day), ruleId, 1);
    tx.expire(RULE_DAY_KEY(scope, day), DAY_TTL_S);
    tx.hincrby(RULE_HOUR_KEY(scope, hour), ruleId, 1);
    tx.expire(RULE_HOUR_KEY(scope, hour), HOUR_TTL_S);
  }
  tx.set(RULE_SINCE_KEY, String(now), "NX");
  const results = await tx.exec();
  const card = results?.[2]?.[1];
  return typeof card === "number" ? card : 0;
}

/** Clears an address's window, after a ban or an unban. */
export async function clearWindow(ip: string): Promise<void> {
  await redis.del(WINDOW_KEY(ip));
}

export type DayCount = { day: string; count: number };

/** Turned-away probes per day, newest first, today included. */
export async function dailyHits(appId: string | null, days: number, now = new Date()): Promise<DayCount[]> {
  const stamps = Array.from({ length: days }, (_, i) => dayStamp(new Date(now.getTime() - i * DAY_MS)));
  const values = await redis.mget(...stamps.map((d) => DAY_KEY(appId ?? ALL, d)));
  return stamps.map((day, i) => ({ day, count: Number(values[i]) || 0 }));
}

/** Turned-away probes over the last `hours` hourly buckets, the current one included. */
export async function hourlyHits(appId: string | null, hours: number, now = new Date()): Promise<number> {
  const keys = Array.from({ length: hours }, (_, i) => HOUR_KEY(appId ?? ALL, hourStamp(new Date(now.getTime() - i * HOUR_MS))));
  const values = await redis.mget(...keys);
  return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/** Turned-away probes over the last seven days, today included. */
export async function hitsThisWeek(appId: string | null, now = new Date()): Promise<number> {
  return (await dailyHits(appId, 7, now)).reduce((sum, d) => sum + d.count, 0);
}

export type RuleHitCounts = { counts: Record<string, number>; since: Date | null };

const stamps = (unit: "hour" | "day", count: number, now: Date) =>
  Array.from({ length: count }, (_, i) =>
    unit === "hour" ? hourStamp(new Date(now.getTime() - i * HOUR_MS)) : dayStamp(new Date(now.getTime() - i * DAY_MS)),
  );

/** Hits per rule id over the last `count` hour or day buckets, the current one included, and when counting began. */
export async function ruleHits(appId: string | null, unit: "hour" | "day", count: number, now = new Date()): Promise<RuleHitCounts> {
  const scope = appId ?? ALL;
  const key = unit === "hour" ? RULE_HOUR_KEY : RULE_DAY_KEY;
  const pipe = redis.pipeline();
  for (const stamp of stamps(unit, count, now)) pipe.hgetall(key(scope, stamp));
  pipe.get(RULE_SINCE_KEY);
  const results = (await pipe.exec()) ?? [];
  const counts: Record<string, number> = {};
  for (const [err, hash] of results.slice(0, -1)) {
    if (err) throw err;
    for (const [id, n] of Object.entries((hash ?? {}) as Record<string, string>)) counts[id] = (counts[id] ?? 0) + (Number(n) || 0);
  }
  const [sinceErr, since] = results[results.length - 1] ?? [null, null];
  if (sinceErr) throw sinceErr;
  const ms = Number(since);
  return { counts, since: since && Number.isFinite(ms) ? new Date(ms) : null };
}
