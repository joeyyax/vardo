// Persistence: five-minute samples per app and signal in RedisTimeSeries, and each app's seen processes and ports.

import { redis } from "@/lib/redis";
import { tsRedis } from "@/lib/metrics/ts-client";
import { BASELINE_WINDOW_MS, type Sample } from "./baseline";
import { decodeSeen, encodeSeen, type SeenEntry } from "./security";
import type { SignalKey } from "./signals";

/** A day past the window, so a full window is always there. */
const SERIES_RETENTION_MS = BASELINE_WINDOW_MS + 24 * 60 * 60_000;
/** A deleted app's allow-set goes after this. */
const SEEN_TTL_S = 30 * 24 * 60 * 60;

export const seriesKey = (appId: string, signal: SignalKey) => `anomaly:${appId}:${signal}`;
const seenKey = (appId: string, kind: SeenKind) => `vardo:anomaly:${kind}:${appId}`;
const metaKey = (appId: string) => `vardo:anomaly:meta:${appId}`;

export type SeenKind = "procs" | "ports";

const created = new Set<string>();

export async function appendSample(appId: string, signal: SignalKey, at: number, value: number): Promise<void> {
  const key = seriesKey(appId, signal);
  if (!created.has(key)) {
    try {
      await tsRedis.call(
        "TS.CREATE", key, "RETENTION", String(SERIES_RETENTION_MS), "DUPLICATE_POLICY", "LAST",
        "LABELS", "kind", "anomaly", "app", appId, "signal", signal,
      );
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("already exists")) throw err;
    }
    created.add(key);
  }
  await tsRedis.call("TS.ADD", key, String(at), String(value), "ON_DUPLICATE", "LAST");
  await tsRedis.call("PEXPIRE", key, String(SERIES_RETENTION_MS));
}

export async function readSamples(appId: string, signal: SignalKey, from: number, to: number): Promise<Sample[]> {
  try {
    const rows = (await tsRedis.call("TS.RANGE", seriesKey(appId, signal), String(from), String(to))) as [string, string][];
    return rows.map(([at, value]) => ({ at: Number(at), value: Number(value) }));
  } catch {
    return [];
  }
}

export async function readSeen(appId: string, kind: SeenKind): Promise<Map<string, SeenEntry>> {
  const raw = await redis.hgetall(seenKey(appId, kind));
  const out = new Map<string, SeenEntry>();
  for (const [item, value] of Object.entries(raw ?? {})) {
    const entry = decodeSeen(value);
    if (entry) out.set(item, entry);
  }
  return out;
}

export async function writeSeen(appId: string, kind: SeenKind, set: Map<string, SeenEntry>, remove: string[]): Promise<void> {
  const key = seenKey(appId, kind);
  const pipe = redis.pipeline();
  if (set.size > 0) pipe.hset(key, Object.fromEntries([...set].map(([item, e]) => [item, encodeSeen(e)])));
  if (remove.length > 0) pipe.hdel(key, ...remove);
  pipe.expire(key, SEEN_TTL_S);
  await pipe.exec();
}

/** When the app's allow-set started learning. Set on first call. */
export async function learningSince(appId: string, now: number): Promise<number> {
  const key = metaKey(appId);
  await redis.hsetnx(key, "learningSince", String(now));
  await redis.expire(key, SEEN_TTL_S);
  return Number(await redis.hget(key, "learningSince")) || now;
}
