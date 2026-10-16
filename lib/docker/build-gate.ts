// Admits builds into BuildKit in FIFO order, as many at once as its memory and the host's cores allow.
// Slots are leased in Redis so a dead process frees its own; Redis being down degrades to this process only.

import { readFile } from "fs/promises";
import { totalmem } from "os";
import { gt, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildPeaks } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { BUILDS_FORMULA, buildConcurrency, resolveBuildConcurrency } from "@/lib/resources/defaults";
import { detectedHost, hostCpuCount } from "@/lib/resources/host";
import { pauseRunningClock } from "@/lib/deploy/running-clock";
import { dockerRequest } from "./client";
import { dockerEnv } from "./docker-env";
import { BUILD_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "./constants";
import { waitForFifoSlot, type SlotPlace, type SlotStore } from "./fifo-slots";
import type { BoundedBuild } from "./build-memory";
import type { WaitWriter } from "./deploy-logger";
import { builderLimitBytes, sizeBuildKit } from "./buildkit-size";
import { lineEtas, slotFreeAt } from "@/lib/deploy/eta";
import { typicalBuildMs } from "@/lib/deploy/eta-history";
import { BuilderError, describeTarget, isTargetReady, markTargetDown, type BuildTarget } from "./build-targets";

const log = logger.child("build-gate");

const BUILD_GATE_KEYS = {
  queue: "build:gate:queue",
  /** Waiters' last poll, so a dead process's entry leaves the head. */
  seen: "build:gate:seen",
  /** Running builds, scored by lease expiry. */
  running: "build:gate:running",
  /** Set while the builder is swept, or after a build ended badly: nothing joins until it empties. */
  hold: "build:gate:hold",
  admits: "build:gate:admits",
  /** When each running build was admitted, for start estimates. */
  started: "build:gate:started",
  /** Waiting builds that may run on a target. */
  remote: "build:gate:remote",
  /** Prefix of each target's running set. */
  target: "build:gate:target:",
};

const LEASE_MS = 45_000;
const RENEW_MS = 10_000;
const WAITER_LEASE_MS = 30_000;
const SWEEP_HOLD_MS = 2 * 60_000;
const DIRTY_HOLD_MS = BUILD_TIMEOUT;
const POLL_MS = 500;
const POSITION_POLL_MS = 2_000;
const SAMPLE_MS = 2_000;
/** A backstop only: leases free a dead holder, so a long wait is a long queue. Waits pause the sweeper's clock. */
export const WAIT_TIMEOUT_MS = 6 * 60 * 60_000;
/** Peaks older than this no longer size builds. */
const PEAK_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** A smaller rise, as from a cached build, isn't recorded and doesn't size builds. */
export const MIN_PEAK_BYTES = 64 * 1024 ** 2;
/** Nor is a build shorter than this. */
const MIN_PEAK_BUILD_MS = 2 * SAMPLE_MS;
const CACHE_MS = 30_000;

// Admits the head here when nothing runs, or when a slot is free and no hold is set. The first build into an empty builder holds it for the sweep.
// Otherwise a build that may run remotely takes the first target with a free slot, unless a live remote-eligible build is ahead of it.
// KEYS: queue, seen, running, hold, admits, started, remote, then each target's running set.
// ARGV: id, limit, leaseMs, waiterLeaseMs, sweepHoldMs, dirtyHoldMs, eligible, then each target's limit.
// Returns {admitted, admit number, alone, target}; target 0 is this host, n the nth target.
const LUA_TRY = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local stale = now - tonumber(ARGV[4])
local lapsed = redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if lapsed > 0 and not redis.call('GET', KEYS[4]) then redis.call('SET', KEYS[4], 'lapsed', 'PX', ARGV[6]) end
if not redis.call('LPOS', KEYS[1], ARGV[1]) then redis.call('RPUSH', KEYS[1], ARGV[1]) end
redis.call('HSET', KEYS[2], ARGV[1], now)
if ARGV[7] == '1' then redis.call('HSET', KEYS[7], ARGV[1], 1) else redis.call('HDEL', KEYS[7], ARGV[1]) end
while true do
  local head = redis.call('LINDEX', KEYS[1], 0)
  if not head or head == ARGV[1] then break end
  local seen = tonumber(redis.call('HGET', KEYS[2], head))
  if seen and seen >= stale then break end
  redis.call('LPOP', KEYS[1])
  redis.call('HDEL', KEYS[2], head)
  redis.call('HDEL', KEYS[7], head)
end
local leave = function()
  redis.call('LREM', KEYS[1], 0, ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[7], ARGV[1])
end
if redis.call('LINDEX', KEYS[1], 0) == ARGV[1] then
  local running = redis.call('ZCARD', KEYS[3])
  local hold = redis.call('GET', KEYS[4])
  local swept = hold and string.sub(hold, 1, 6) == 'sweep:'
  if not swept and not (running > 0 and (hold or running >= tonumber(ARGV[2]))) then
    leave()
    redis.call('ZADD', KEYS[3], now + tonumber(ARGV[3]), ARGV[1])
    if running == 0 then redis.call('DEL', KEYS[6]) end
    redis.call('HSET', KEYS[6], ARGV[1], now)
    local n = redis.call('INCR', KEYS[5])
    if running == 0 then
      redis.call('SET', KEYS[4], 'sweep:' .. ARGV[1], 'PX', ARGV[5])
      return {1, n, 1, 0}
    end
    return {1, n, 0, 0}
  end
end
if ARGV[7] ~= '1' or #KEYS < 8 then return {0, 0, 0, 0} end
for _, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  if entry == ARGV[1] then break end
  if redis.call('HGET', KEYS[7], entry) then
    local seen = tonumber(redis.call('HGET', KEYS[2], entry))
    if seen and seen >= stale then return {0, 0, 0, 0} end
    redis.call('LREM', KEYS[1], 0, entry)
    redis.call('HDEL', KEYS[2], entry)
    redis.call('HDEL', KEYS[7], entry)
  end
end
for i = 8, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) < tonumber(ARGV[i]) then
    leave()
    redis.call('ZADD', KEYS[i], now + tonumber(ARGV[3]), ARGV[1])
    return {1, 0, 0, i - 7}
  end
end
return {0, 0, 0, 0}
`;

// KEYS: running, hold, admits, started. ARGV: id, dirty, dirtyHoldMs. Returns the admit count, which says whether anyone joined.
const LUA_RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
if ARGV[2] == '1' then
  local hold = redis.call('GET', KEYS[2])
  if not hold or string.sub(hold, 1, 6) ~= 'sweep:' then redis.call('SET', KEYS[2], 'dirty', 'PX', ARGV[3]) end
end
return tonumber(redis.call('GET', KEYS[3]) or '0')
`;

// Takes the sweep hold when nothing runs. KEYS: running, hold. ARGV: id, sweepHoldMs.
const LUA_CLAIM_SWEEP = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) > 0 then return 0 end
local hold = redis.call('GET', KEYS[2])
if hold and string.sub(hold, 1, 6) == 'sweep:' then return 0 end
redis.call('SET', KEYS[2], 'sweep:' .. ARGV[1], 'PX', ARGV[2])
return 1
`;

// KEYS: running set, local or a target's. ARGV: id, leaseMs.
const LUA_RENEW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
return 1
`;

// Moves a deployment's waiting build to the head of the queue. KEYS: queue. ARGV: deployment id. Returns 1 when moved.
const LUA_BUMP = `
local prefix = ARGV[1] .. ':'
for _, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  if string.sub(entry, 1, #prefix) == prefix then
    redis.call('LREM', KEYS[1], 0, entry)
    redis.call('LPUSH', KEYS[1], entry)
    return 1
  end
end
return 0
`;

/** `target` is the remote target's id, null for this host. */
type Admission = { gen: number; alone: boolean; local: boolean; target: string | null };

/** A target's id and how many builds it takes at once. */
export type TargetSlot = { id: string; limit: number };

/** The queue in order and the running builds with when each was admitted (epoch ms, null when unknown). */
export type GateSnapshot = { queue: string[]; running: { id: string; since: number | null }[] };

type Keys = typeof BUILD_GATE_KEYS;

/** The Redis store; `keys` is for tests. */
export function redisBuildStore(keys: Keys = BUILD_GATE_KEYS, client = redis): SlotStore<Admission> & {
  /** As tryAcquire, overflowing to the first target with a free slot when this host has none. */
  tryAcquireAt(id: string, limit: number, targets: TargetSlot[]): Promise<Admission | null>;
  release(id: string, dirty: boolean): Promise<number>;
  releaseTarget(id: string, target: string): Promise<void>;
  renew(id: string, target?: string | null): Promise<void>;
  claimSweep(id: string): Promise<boolean>;
  endSweep(): Promise<void>;
  runningCount(): Promise<number>;
  snapshot(): Promise<GateSnapshot>;
  bump(deploymentId: string): Promise<boolean>;
} {
  const tryAcquireAt = async (id: string, limit: number, targets: TargetSlot[]): Promise<Admission | null> => {
    const [admitted, gen, alone, at] = (await client.eval(
      LUA_TRY, 7 + targets.length, keys.queue, keys.seen, keys.running, keys.hold, keys.admits, keys.started, keys.remote,
      ...targets.map((t) => keys.target + t.id),
      id, String(limit), String(LEASE_MS), String(WAITER_LEASE_MS), String(SWEEP_HOLD_MS), String(DIRTY_HOLD_MS),
      targets.length > 0 ? "1" : "0", ...targets.map((t) => String(t.limit)),
    )) as number[];
    if (admitted !== 1) return null;
    return { gen, alone: alone === 1, local: false, target: at > 0 ? (targets[at - 1]?.id ?? null) : null };
  };
  return {
    tryAcquire: (id, limit) => tryAcquireAt(id, limit, []),
    tryAcquireAt,
    async place(id) {
      try {
        const [[, index], [, total]] = (await client.multi().lpos(keys.queue, id).llen(keys.queue).exec()) ?? [[], []];
        return typeof index === "number" && typeof total === "number" ? { ahead: index, total } : "unknown";
      } catch {
        return "unknown";
      }
    },
    async remove(id) {
      await client.lrem(keys.queue, 0, id);
      await client.hdel(keys.seen, id);
      await client.hdel(keys.remote, id);
    },
    async releaseTarget(id, target) {
      await client.zrem(keys.target + target, id);
    },
    async release(id, dirty) {
      return Number(
        await client.eval(LUA_RELEASE, 4, keys.running, keys.hold, keys.admits, keys.started, id, dirty ? "1" : "0", String(DIRTY_HOLD_MS)),
      );
    },
    async renew(id, target) {
      await client.eval(LUA_RENEW, 1, target ? keys.target + target : keys.running, id, String(LEASE_MS));
    },
    async claimSweep(id) {
      return (await client.eval(LUA_CLAIM_SWEEP, 2, keys.running, keys.hold, id, String(SWEEP_HOLD_MS))) === 1;
    },
    async endSweep() {
      await client.del(keys.hold);
    },
    async runningCount() {
      return client.zcard(keys.running);
    },
    async snapshot() {
      const [[, queue], [, running], [, started]] = ((await client
        .multi()
        .lrange(keys.queue, 0, -1)
        .zrangebyscore(keys.running, Date.now(), "+inf")
        .hgetall(keys.started)
        .exec()) ?? []) as [unknown, unknown][];
      const since = (started ?? {}) as Record<string, string>;
      return {
        queue: (queue ?? []) as string[],
        running: ((running ?? []) as string[]).map((id) => ({ id, since: since[id] ? Number(since[id]) : null })),
      };
    },
    async bump(deploymentId) {
      return Number(await client.eval(LUA_BUMP, 1, keys.queue, deploymentId)) === 1;
    },
  };
}

/** In-process FIFO for when Redis is down. Never sweeps or records: other processes' builds are invisible. */
export function localBuildStore(): SlotStore<Admission> & { release(id: string): void; runningCount(): number } {
  const queue: string[] = [];
  const running = new Set<string>();
  return {
    async tryAcquire(id, limit) {
      if (!queue.includes(id)) queue.push(id);
      if (queue[0] !== id || (running.size > 0 && running.size >= limit)) return null;
      queue.shift();
      running.add(id);
      return { gen: 0, alone: false, local: true, target: null };
    },
    async place(id) {
      const index = queue.indexOf(id);
      return index === -1 ? "unknown" : { ahead: index, total: queue.length };
    },
    async remove(id) {
      const index = queue.indexOf(id);
      if (index !== -1) queue.splice(index, 1);
    },
    release(id) {
      running.delete(id);
    },
    runningCount: () => running.size,
  };
}

const gateStores = { redis: redisBuildStore(), local: localBuildStore() };

/** Test hook: swap the stores and clear the peak cache. */
export function resetBuildGateForTests(redisStore: ReturnType<typeof redisBuildStore> = redisBuildStore()): void {
  gateStores.redis = redisStore;
  gateStores.local = localBuildStore();
  peakCache = { at: 0, bytes: null };
}

/** The deployment a gate token belongs to, or null for a build without one. */
function tokenDeployment(token: string): string | null {
  const id = token.slice(0, token.lastIndexOf(":"));
  return id && id !== "build" ? id : null;
}

/** When `id`'s build should start: running builds free at their app's typical build time, then each build ahead takes the earliest free slot. */
export async function buildEta(
  store: Pick<ReturnType<typeof redisBuildStore>, "snapshot">,
  id: string,
  limit: number,
  now = Date.now(),
): Promise<number | null> {
  const snap = await store.snapshot();
  const index = snap.queue.indexOf(id);
  if (index === -1) return null;
  const ahead = snap.queue.slice(0, index);
  const ids = [...snap.running.map((r) => r.id), ...ahead].map(tokenDeployment).filter((d): d is string => d !== null);
  const typical = await typicalBuildMs(ids);
  const typicalOf = (token: string) => {
    const deployment = tokenDeployment(token);
    return deployment ? (typical.get(deployment) ?? null) : null;
  };
  const busy = snap.running.map((r) => (r.since === null ? null : slotFreeAt(now, r.since, typicalOf(r.id))));
  const idle = Array.from({ length: Math.max(0, limit - busy.length) }, () => now);
  return lineEtas(now, [...busy, ...idle], [...ahead.map(typicalOf), null])[index] ?? null;
}

/** Moves a deployment's waiting build to the head of the builder queue. False when it isn't waiting there. */
export async function bumpBuild(deploymentId: string): Promise<boolean> {
  return gateStores.redis.bump(deploymentId);
}

/** "some avg10" from /proc/pressure/memory, null when the kernel has no PSI. */
export function parseMemoryPressure(text: string): number | null {
  const avg10 = text.match(/^some\b.*\bavg10=([\d.]+)/m)?.[1];
  return avg10 === undefined ? null : Number(avg10);
}

async function memoryPressure(): Promise<number | null> {
  try {
    return parseMemoryPressure(await readFile("/proc/pressure/memory", "utf-8"));
  } catch {
    return null;
  }
}

let peakCache: { at: number; bytes: number | null } = { at: 0, bytes: null };

/** The largest build peak recorded across apps lately, or null. */
async function largestRecentPeak(): Promise<number | null> {
  if (Date.now() - peakCache.at < CACHE_MS) return peakCache.bytes;
  try {
    const [row] = await db
      .select({ peak: max(buildPeaks.peakBytes) })
      .from(buildPeaks)
      .where(gt(buildPeaks.recordedAt, new Date(Date.now() - PEAK_WINDOW_MS)));
    // The largest is below the floor only when every row is.
    const peak = row?.peak == null ? null : Number(row.peak);
    peakCache = { at: Date.now(), bytes: peak !== null && peak >= MIN_PEAK_BYTES ? peak : null };
  } catch (err) {
    log.warn("Couldn't read recorded build peaks; sizing builds by the default budget:", err);
    peakCache = { at: Date.now(), bytes: null };
  }
  return peakCache.bytes;
}

type BuildLimitInput = {
  /** BuildKit's memory limit, 0 when it has none or builds run on the daemon. */
  limitBytes: number;
  hostMemoryBytes: number;
  cpus: number;
  largestPeakBytes: number | null;
  memoryPressureAvg10: number | null;
  env?: Record<string, string | undefined>;
};

/** Builds at once and why the limit is what it is. */
export function buildLimit(input: BuildLimitInput): { limit: number; usableBytes: number; budgetBytes: number; pressured: boolean } {
  const usableBytes = input.limitBytes > 0
    ? Math.max(0, input.limitBytes - BUILDS_FORMULA.buildkitdBytes)
    : Math.floor(input.hostMemoryBytes * BUILDS_FORMULA.unboundedShare);
  const budgetBytes = input.largestPeakBytes ?? BUILDS_FORMULA.budgetBytes;
  const pressured = (input.memoryPressureAvg10 ?? 0) >= BUILDS_FORMULA.pressureAvg10;
  const rule = buildConcurrency({ cpus: input.cpus, usableBytes, budgetBytes });
  const limit = resolveBuildConcurrency(rule, { env: input.env, memoryPressure: pressured }).value;
  return { limit, usableBytes, budgetBytes, pressured };
}

async function currentLimit(bounded: BoundedBuild) {
  const host = detectedHost();
  // Live, since sizeBuildKit may have resized it.
  const live = bounded.container ? await builderLimitBytes(bounded.container) : null;
  return buildLimit({
    limitBytes: live ?? bounded.limitBytes ?? 0,
    hostMemoryBytes: host?.memoryBytes ?? totalmem(),
    cpus: hostCpuCount(host),
    largestPeakBytes: await largestRecentPeak(),
    memoryPressureAvg10: await memoryPressure(),
  });
}

/** Anonymous memory in the container's cgroup, which leaves out the page cache a build fills. */
async function builderMemory(container: string): Promise<number | null> {
  try {
    const stats = await dockerRequest<{ memory_stats?: { usage?: number; stats?: Record<string, number> } }>(
      "GET",
      `/containers/${encodeURIComponent(container)}/stats?stream=false&one-shot=true`,
      undefined,
      { timeoutMs: 5_000 },
    );
    const m = stats.memory_stats;
    const value = m?.stats?.anon ?? m?.stats?.rss ?? (m?.usage !== undefined ? m.usage - (m.stats?.inactive_file ?? 0) : undefined);
    return typeof value === "number" && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Samples the builder's memory until stopped; returns the rise over the first sample. */
function sampleBuilder(container: string): { stop: () => Promise<number | null> } {
  let base: number | null = null;
  let peak: number | null = null;
  const take = async () => {
    const value = await builderMemory(container);
    if (value === null) return;
    if (base === null) base = value;
    peak = Math.max(peak ?? value, value);
  };
  const first = take();
  const timer = setInterval(() => void take(), SAMPLE_MS);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await first;
      await take();
      return base !== null && peak !== null ? Math.max(0, peak - base) : null;
    },
  };
}

type RuncContainer = { id: string; status: string };

const inBuilder = (container: string, args: string[]) =>
  execFileAsync("docker", ["exec", container, ...args], { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT });

/** Step cgroups that still hold processes, which catches a step runc no longer lists. cgroupfs files stat as empty, so read them. */
const OCCUPIED_CGROUPS =
  'for f in /sys/fs/cgroup/buildkit/*/cgroup.procs; do [ -n "$(cat "$f" 2>/dev/null)" ] && basename "$(dirname "$f")"; done; true';

async function runningSteps(container: string): Promise<string[]> {
  const { stdout } = await inBuilder(container, ["buildkit-runc", "list", "--format", "json"]);
  const list = JSON.parse(stdout.trim() || "null") as RuncContainer[] | null;
  const steps = new Set((list ?? []).filter((c) => c.status === "running").map((c) => c.id));
  const cgroups = await inBuilder(container, ["sh", "-c", OCCUPIED_CGROUPS]).catch(() => ({ stdout: "" }));
  for (const id of String(cgroups.stdout).split("\n").map((s) => s.trim())) if (id) steps.add(id);
  return [...steps];
}

/** Kills build steps still running in an idle builder, left by a build whose client died. Returns how many, or null if unreadable. */
async function sweepOrphanSteps(container: string, opts: { waitMs?: number } = {}): Promise<{ killed: number; clean: boolean } | null> {
  let steps: string[];
  try {
    steps = await runningSteps(container);
  } catch {
    return null;
  }
  if (steps.length === 0) return { killed: 0, clean: true };
  for (const id of steps) {
    await inBuilder(container, ["buildkit-runc", "kill", id, "KILL"]).catch(() => {});
    await inBuilder(container, ["sh", "-c", 'echo 1 > "/sys/fs/cgroup/buildkit/$1/cgroup.kill"', "_", id]).catch(() => {});
  }
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    const left = await runningSteps(container).catch(() => steps);
    if (left.length === 0) return { killed: steps.length, clean: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { killed: steps.length, clean: false };
}

async function sweep(container: string | undefined, logLine: (line: string) => void): Promise<void> {
  if (!container) return;
  const swept = await sweepOrphanSteps(container);
  if (!swept || swept.killed === 0) return;
  logLine(
    swept.clean
      ? `[build] Stopped ${swept.killed} build step(s) an earlier build left running in ${container}`
      : `[build] Warning: ${swept.killed} build step(s) an earlier build left in ${container} didn't stop`,
  );
}

/** Whether a build's rise is big and long enough to record. */
export function recordablePeak(riseBytes: number | null, buildMs: number): riseBytes is number {
  return riseBytes !== null && riseBytes >= MIN_PEAK_BYTES && buildMs >= MIN_PEAK_BUILD_MS;
}

async function recordPeak(deploymentId: string, bytes: number): Promise<void> {
  await db
    .insert(buildPeaks)
    .values({ deploymentId, peakBytes: bytes })
    .onConflictDoUpdate({
      target: buildPeaks.deploymentId,
      set: { peakBytes: sql`greatest(${buildPeaks.peakBytes}, excluded.peak_bytes)`, recordedAt: new Date() },
    });
  peakCache = { at: 0, bytes: null };
}

export type BuildGate = {
  /** Without it the build is gated but neither records a peak nor pauses the sweeper's clock. */
  deploymentId?: string;
  log: (line: string) => void;
  /** Opens a `build-slot` wait on the deploy's stream and row, which also pauses its sweeper clock. */
  wait?: WaitWriter;
  signal?: AbortSignal;
  /** Targets this build may overflow to, in order. Without any it builds here. */
  targets?: BuildTarget[];
};

/** Where an admitted build runs: a target, or this host when null. */
export type BuildPlacement = { target: BuildTarget | null };

/**
 * Runs `build` once this host or a target has a slot for it. Records the builder's memory peak when the build ran alone here.
 * A build a target failed for the target's own reasons runs again here.
 */
export async function withBuildSlot<T>(gate: BuildGate, bounded: BoundedBuild, build: (placement: BuildPlacement) => Promise<T>): Promise<T> {
  const store = gateStores.redis;
  const targets = gate.targets ?? [];
  const readyTargets = async (): Promise<TargetSlot[]> => {
    const ready = await Promise.all(targets.map((t) => isTargetReady(t)));
    return targets.filter((_, i) => ready[i]).map((t) => ({ id: t.id, limit: t.maxConcurrent }));
  };
  const gated: SlotStore<Admission> = {
    tryAcquire: async (slotId, limit) => store.tryAcquireAt(slotId, limit, targets.length > 0 ? await readyTargets() : []),
    place: (slotId) => store.place(slotId),
    remove: (slotId) => store.remove(slotId),
  };
  // A build that retries in the same deploy queues on its own token.
  const id = `${gate.deploymentId ?? "build"}:${Math.random().toString(36).slice(2, 8)}`;
  let latest = await currentLimit(bounded);
  const limit = async () => (latest = await currentLimit(bounded)).limit;

  // One estimate at a time; reads during one are skipped.
  let estimating = false;
  let waiting = true;
  const reportPlace = async (place: SlotPlace) => {
    if (!gate.wait || estimating) return;
    estimating = true;
    try {
      const eta = local ? null : await buildEta(store, id, latest.limit).catch(() => null);
      // The wait may have ended while the estimate ran.
      if (waiting) await gate.wait("build-slot", { ...place, eta });
    } finally {
      estimating = false;
    }
  };

  let local = false;
  const toLocal = (err: unknown) => {
    local = true;
    log.warn("Redis unavailable for the build gate — queuing builds in this process only:", err);
    gate.log("[build] Warning: couldn't reach Redis for the build queue; queuing builds in this process only");
  };
  const localOpts = () => ({ ...waitOpts, onStoreError: (err: unknown): never => { throw err; } });
  const waitOpts = {
    limit,
    signal: gate.signal,
    onPosition: (place: SlotPlace) => void reportPlace(place),
    timeoutMs: WAIT_TIMEOUT_MS,
    pollMs: POLL_MS,
    positionPollMs: POSITION_POLL_MS,
    messages: {
      aborted: "Deployment aborted",
      timedOut: "Timed out waiting for the builder",
      removed: "The build was taken out of the builder queue",
    },
    onStoreError: (err: unknown) => {
      toLocal(err);
      return waitForFifoSlot(gateStores.local, id, localOpts());
    },
  };

  // This host first, without waiting on target checks.
  let slot = await store.tryAcquire(id, latest.limit).catch((err) => {
    toLocal(err);
    return gateStores.local.tryAcquire(id, latest.limit);
  });
  if (!slot) {
    const running = local ? gateStores.local.runningCount() : await store.runningCount().catch(() => null);
    gate.log(
      `[queue] Waiting for the builder: ${running ?? "?"} running, ${latest.limit} at a time` +
        (latest.pressured ? " (host memory under pressure)" : "") +
        (targets.length > 0 && !local ? `, or a slot on ${targets.map((t) => t.name).join(", ")}` : ""),
    );
    // The wait writer pauses the sweeper's clock; without one the gate pauses it itself.
    void gate.wait?.("build-slot");
    const clock = !gate.wait && gate.deploymentId ? pauseRunningClock(gate.deploymentId) : null;
    try {
      slot = local ? await waitForFifoSlot(gateStores.local, id, localOpts()) : await waitForFifoSlot(gated, id, waitOpts);
    } finally {
      waiting = false;
      await gate.wait?.(null);
      await clock?.resume();
    }
    gate.log("[queue] Builder free, starting build");
  }
  const placed = slot.target ? (targets.find((t) => t.id === slot.target) ?? null) : null;
  if (placed) return runRemote(placed);
  if (targets.length > 0) gate.log("[build] Building on this server");
  return runHeld(slot);

  async function runRemote(on: BuildTarget): Promise<T> {
    gate.log(`[build] Building on ${describeTarget(on)}`);
    const renew = setInterval(() => void store.renew(id, on.id).catch(() => {}), RENEW_MS);
    renew.unref?.();
    try {
      return await build({ target: on });
    } catch (err) {
      if (!(err instanceof BuilderError) || gate.signal?.aborted) throw err;
      markTargetDown(on);
      log.warn(`Build target ${on.name} failed: ${err.reason}`, err.cause);
      gate.log(`[build] ${on.name} couldn't build: ${err.reason}. Building on this server instead`);
    } finally {
      clearInterval(renew);
      await store.releaseTarget(id, on.id).catch(() => {});
    }
    return withBuildSlot({ ...gate, targets: [] }, bounded, build);
  }

  async function runHeld(held: Admission): Promise<T> {
    if (held.local) {
      try {
        return await build({ target: null });
      } finally {
        gateStores.local.release(id);
      }
    }

    const renew = setInterval(() => void store.renew(id).catch(() => {}), RENEW_MS);
    renew.unref?.();
    let ok = false;
    let sampler: ReturnType<typeof sampleBuilder> | null = null;
    let buildStart = Date.now();
    try {
      if (held.alone) {
        try {
          await sweep(bounded.container, gate.log);
          // The sweep hold keeps the builder empty, so it can be resized.
          const container = bounded.container;
          if (container) {
            const sized = await sizeBuildKit(container, { builderBytes: () => builderMemory(container), log: gate.log });
            if (sized !== null) bounded.limitBytes = sized;
          }
        } finally {
          await store.endSweep().catch(() => {});
        }
        if (bounded.container) sampler = sampleBuilder(bounded.container);
      }
      buildStart = Date.now();
      const result = await build({ target: null });
      ok = true;
      return result;
    } finally {
      clearInterval(renew);
      const buildMs = Date.now() - buildStart;
      const rise = sampler ? await sampler.stop() : null;
      const admits = await store.release(id, !ok).catch(() => null);
      // Alone at admission and nobody admitted since: the builder's rise is this build's.
      if (ok && gate.deploymentId && held.alone && admits === held.gen && recordablePeak(rise, buildMs)) {
        await recordPeak(gate.deploymentId, rise).catch((err) => log.warn("Couldn't record the build's memory peak:", err));
      }
      // A build that ended badly may have left steps running; clear them now if the builder is idle.
      if (!ok && bounded.container && (await store.claimSweep(id).catch(() => false))) {
        try {
          await sweep(bounded.container, gate.log);
        } finally {
          await store.endSweep().catch(() => {});
        }
      }
    }
  }
}
