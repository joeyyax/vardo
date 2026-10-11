// Blocked-request counts: batched in memory, flushed to Redis per day and source and to each ban's row.

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { dayStamp } from "./hits";
import { BLOCK_SOURCES, type BlockMatch, type BlockSource } from "./block-source";

const log = logger.child("probe-guard");

const COUNT_KEY = (day: string) => `probe-guard:blocked:${day}`;
const IPS_KEY = (source: BlockSource, day: string) => `probe-guard:blocked-ips:${source}:${day}`;
const RANGES_KEY = (day: string) => `probe-guard:blocked-ranges:${day}`;
export const BLOCKED_DAYS = 30;
export const BLOCKED_TTL_S = (BLOCKED_DAYS + 1) * 86_400;
export const FLUSH_MS = 15_000;
/** Distinct addresses, ranges and bans held between flushes. Past it, only counts grow. */
export const MAX_PENDING = 5_000;
const DAY_MS = 86_400_000;

export type BanBlocks = { id: string; count: number; lastAt: Date };

type Batch = {
  counts: Map<string, number>;
  ips: Map<string, Set<string>>;
  ranges: Map<string, Set<string>>;
  bans: Map<string, { count: number; lastAt: number }>;
  distinct: number;
};

const empty = (): Batch => ({ counts: new Map(), ips: new Map(), ranges: new Map(), bans: new Map(), distinct: 0 });

let batch = empty();
let timer: ReturnType<typeof setTimeout> | null = null;
let writeBans: (rows: BanBlocks[]) => Promise<void> = async (rows) => (await import("./bans")).addBanBlocks(rows);

/** Swaps the ban writer, for tests. */
export function setBanBlocksWriter(fn: (rows: BanBlocks[]) => Promise<void>): void {
  writeBans = fn;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string, b: Batch): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  if (set.has(value) || b.distinct >= MAX_PENDING) return;
  set.add(value);
  b.distinct++;
}

/** Counts one blocked request. Never throws and never waits. */
export function recordBlock(ip: string, match: BlockMatch, now = Date.now()): void {
  const day = dayStamp(new Date(now));
  const b = batch;
  const key = `${day}|${match.source}`;
  b.counts.set(key, (b.counts.get(key) ?? 0) + 1);
  addTo(b.ips, key, ip, b);
  if (match.range) addTo(b.ranges, day, match.range, b);
  if (match.banId) {
    const prev = b.bans.get(match.banId);
    if (prev) {
      prev.count++;
      prev.lastAt = Math.max(prev.lastAt, now);
    } else if (b.distinct < MAX_PENDING) {
      b.bans.set(match.banId, { count: 1, lastAt: now });
      b.distinct++;
    }
  }
  timer ??= setTimeout(() => void flushBlocks(), FLUSH_MS);
  timer.unref?.();
}

/** Writes and clears what's pending. A failed write is dropped, not retried. */
export async function flushBlocks(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const b = batch;
  batch = empty();
  if (b.counts.size === 0) return;

  const tx = redis.pipeline();
  for (const [key, n] of b.counts) {
    const [day, source] = key.split("|");
    tx.hincrby(COUNT_KEY(day), source, n);
    tx.expire(COUNT_KEY(day), BLOCKED_TTL_S);
  }
  for (const [key, ips] of b.ips) {
    if (ips.size === 0) continue;
    const [day, source] = key.split("|");
    tx.pfadd(IPS_KEY(source as BlockSource, day), ...ips);
    tx.expire(IPS_KEY(source as BlockSource, day), BLOCKED_TTL_S);
  }
  for (const [day, ranges] of b.ranges) {
    tx.pfadd(RANGES_KEY(day), ...ranges);
    tx.expire(RANGES_KEY(day), BLOCKED_TTL_S);
  }
  const bans = [...b.bans].map(([id, v]) => ({ id, count: v.count, lastAt: new Date(v.lastAt) }));
  await Promise.all([
    tx.exec().catch((err) => log.warn("Couldn't write blocked counts:", err)),
    bans.length > 0 ? writeBans(bans).catch((err) => log.warn("Couldn't write ban block counts:", err)) : null,
  ]);
}

export type SourceBlocks = {
  source: BlockSource;
  today: number;
  week: number;
  month: number;
  /** Distinct addresses over the 30 days, approximate past a few hundred. */
  uniqueIps: number;
  /** Requests per day, oldest first, today last. */
  daily: number[];
};

export type BlockedSummary = {
  sources: SourceBlocks[];
  other: number;
  /** Distinct Spamhaus ranges hit over the 30 days. */
  rangesHit: number;
  days: string[];
};

/** Per-source totals and daily counts over the last 30 days, today included. */
export async function blockedSummary(now = new Date()): Promise<BlockedSummary> {
  const days = Array.from({ length: BLOCKED_DAYS }, (_, i) => dayStamp(new Date(now.getTime() - (BLOCKED_DAYS - 1 - i) * DAY_MS)));
  const pipe = redis.pipeline();
  for (const day of days) pipe.hgetall(COUNT_KEY(day));
  for (const source of BLOCK_SOURCES) pipe.pfcount(...days.map((d) => IPS_KEY(source, d)));
  pipe.pfcount(...days.map(RANGES_KEY));
  const results = (await pipe.exec()) ?? [];
  for (const [err] of results) if (err) throw err;
  const hashes = results.slice(0, days.length).map(([, h]) => (h ?? {}) as Record<string, string>);
  const series = (source: BlockSource) => hashes.map((h) => Number(h[source]) || 0);
  const sum = (list: number[]) => list.reduce((a, n) => a + n, 0);

  const sources = BLOCK_SOURCES.map((source, i) => {
    const daily = series(source);
    return {
      source,
      today: daily[daily.length - 1],
      week: sum(daily.slice(-7)),
      month: sum(daily),
      uniqueIps: Number(results[days.length + i]?.[1]) || 0,
      daily,
    };
  });
  return {
    sources,
    other: sum(series("other")),
    rangesHit: Number(results[days.length + BLOCK_SOURCES.length]?.[1]) || 0,
    days,
  };
}
