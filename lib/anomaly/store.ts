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

/** "baseline" leaves out episode samples; "all" keeps them for the app's peak. */
export type Series = "baseline" | "all";

export const seriesKey = (appId: string, signal: SignalKey, series: Series = "baseline") =>
  series === "all" ? `anomaly:${appId}:${signal}:all` : `anomaly:${appId}:${signal}`;
const seenKey = (appId: string, kind: SeenKind) => `vardo:anomaly:${kind}:${appId}`;
const metaKey = (appId: string) => `vardo:anomaly:meta:${appId}`;

export type SeenKind = "procs" | "ports";
const SEEN_KINDS: SeenKind[] = ["procs", "ports"];
const knownField = (kind: SeenKind) => `known:${kind}`;

const created = new Set<string>();

export async function appendSample(appId: string, signal: SignalKey, at: number, value: number, series: Series = "baseline"): Promise<void> {
  const key = seriesKey(appId, signal, series);
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

export async function readSamples(appId: string, signal: SignalKey, from: number, to: number, series: Series = "baseline"): Promise<Sample[]> {
  try {
    const rows = (await tsRedis.call("TS.RANGE", seriesKey(appId, signal, series), String(from), String(to))) as [string, string][];
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

/** Writes allow-set changes and whether the set now holds any known entries. */
export async function writeSeen(appId: string, kind: SeenKind, set: Map<string, SeenEntry>, remove: string[], hasKnown: boolean): Promise<void> {
  const key = seenKey(appId, kind);
  const pipe = redis.pipeline();
  if (set.size > 0) pipe.hset(key, Object.fromEntries([...set].map(([item, e]) => [item, encodeSeen(e)])));
  if (remove.length > 0) pipe.hdel(key, ...remove);
  pipe.hset(metaKey(appId), knownField(kind), hasKnown ? "1" : "0");
  for (const k of [key, metaKey(appId)]) pipe.expire(k, SEEN_TTL_S);
  await pipe.exec();
}

export async function forgetSeen(appId: string, kind: SeenKind): Promise<void> {
  await redis.del(seenKey(appId, kind));
}

export type AppMeta = {
  learningSince: number;
  /** Whether each allow-set held known entries at its last write; missing before the first write that recorded it. */
  hasKnown: Partial<Record<SeenKind, boolean>>;
};

/** Starts the app's learning clock on first call and refreshes its meta and allow-set TTLs together. */
export async function touchApp(appId: string, now: number): Promise<AppMeta> {
  const meta = metaKey(appId);
  const pipe = redis.pipeline();
  pipe.hsetnx(meta, "learningSince", String(now));
  for (const key of [meta, ...SEEN_KINDS.map((kind) => seenKey(appId, kind))]) pipe.expire(key, SEEN_TTL_S);
  pipe.hgetall(meta);
  const results = (await pipe.exec()) ?? [];
  const [err, raw] = results[results.length - 1] ?? [];
  if (err) throw err;
  const fields = (raw ?? {}) as Record<string, string>;
  const hasKnown: AppMeta["hasKnown"] = {};
  for (const kind of SEEN_KINDS) {
    const value = fields[knownField(kind)];
    if (value !== undefined) hasKnown[kind] = value === "1";
  }
  return { learningSince: Number(fields.learningSince) || now, hasKnown };
}

const PIDS_RESET_KEY = "vardo:anomaly:pids-reset:2";

/** Deletes every app's pids samples from `since` to `now` once per Redis. */
export async function resetPidsSamples(since: number, now: number): Promise<void> {
  if (await redis.get(PIDS_RESET_KEY)) return;
  const keys = (await tsRedis.call("TS.QUERYINDEX", "kind=anomaly", "signal=pids")) as string[];
  for (const key of keys) await tsRedis.call("TS.DEL", key, String(since), String(now));
  await redis.set(PIDS_RESET_KEY, String(now));
}

const SEEN_REPAIR_KEY = "vardo:anomaly:seen-repair:1";

export type LostSet = { appId: string; kind: SeenKind };

/** Once per Redis: marks every entry known in allow-sets with no known entries, after `settle` clears their alerts. */
export async function repairLostSeen(now: number, settle: (lost: LostSet[]) => Promise<void>): Promise<LostSet[]> {
  if (await redis.get(SEEN_REPAIR_KEY)) return [];
  const lost: (LostSet & { entries: Map<string, SeenEntry> })[] = [];
  for (const kind of SEEN_KINDS) {
    const prefix = seenKey("", kind);
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const appId = key.slice(prefix.length);
        const entries = await readSeen(appId, kind);
        if (entries.size > 0 && ![...entries.values()].some((e) => e.state === "known")) lost.push({ appId, kind, entries });
      }
    } while (cursor !== "0");
  }
  const found = lost.map(({ appId, kind }) => ({ appId, kind }));
  await settle(found);
  for (const { appId, kind, entries } of lost) {
    const known = new Map([...entries].map(([item, e]): [string, SeenEntry] => [item, { state: "known", first: e.first }]));
    await writeSeen(appId, kind, known, [], true);
  }
  await redis.set(SEEN_REPAIR_KEY, String(now));
  return found;
}
