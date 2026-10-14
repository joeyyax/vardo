// Admits builds into BuildKit in FIFO order, as many at once as its memory and the host's cores allow.
// Slots are leased in Redis so a dead process frees its own; Redis being down degrades to this process only.

import { readFile } from "fs/promises";
import { totalmem } from "os";
import { and, gt, isNotNull, max, sql, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { BUILDS_FORMULA, buildConcurrency, resolveBuildConcurrency } from "@/lib/resources/defaults";
import { detectedHost, hostCpuCount } from "@/lib/resources/host";
import { dockerRequest } from "./client";
import { dockerEnv } from "./docker-env";
import { BUILD_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "./constants";
import { waitForFifoSlot, type SlotStore } from "./fifo-slots";
import type { BoundedBuild } from "./build-memory";
import type { WaitWriter } from "./deploy-logger";

const log = logger.child("build-gate");

export const BUILD_GATE_KEYS = {
  queue: "build:gate:queue",
  /** Waiters' last poll, so a dead process's entry leaves the head. */
  seen: "build:gate:seen",
  /** Running builds, scored by lease expiry. */
  running: "build:gate:running",
  /** Set while the builder is swept, or after a build ended badly: nothing joins until it empties. */
  hold: "build:gate:hold",
  admits: "build:gate:admits",
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
const CACHE_MS = 30_000;

// Admits the head when nothing runs, or when a slot is free and no hold is set. The first build into an empty builder holds it for the sweep.
// KEYS: queue, seen, running, hold, admits. ARGV: id, limit, leaseMs, waiterLeaseMs, sweepHoldMs, dirtyHoldMs.
// Returns {admitted, admit number, alone}.
const LUA_TRY = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lapsed = redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if lapsed > 0 and not redis.call('GET', KEYS[4]) then redis.call('SET', KEYS[4], 'lapsed', 'PX', ARGV[6]) end
if not redis.call('LPOS', KEYS[1], ARGV[1]) then redis.call('RPUSH', KEYS[1], ARGV[1]) end
redis.call('HSET', KEYS[2], ARGV[1], now)
while true do
  local head = redis.call('LINDEX', KEYS[1], 0)
  if not head or head == ARGV[1] then break end
  local seen = tonumber(redis.call('HGET', KEYS[2], head))
  if seen and seen >= now - tonumber(ARGV[4]) then break end
  redis.call('LPOP', KEYS[1])
  redis.call('HDEL', KEYS[2], head)
end
if redis.call('LINDEX', KEYS[1], 0) ~= ARGV[1] then return {0, 0, 0} end
local running = redis.call('ZCARD', KEYS[3])
local hold = redis.call('GET', KEYS[4])
if hold and string.sub(hold, 1, 6) == 'sweep:' then return {0, 0, 0} end
if running > 0 and (hold or running >= tonumber(ARGV[2])) then return {0, 0, 0} end
redis.call('LPOP', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[3]), ARGV[1])
local n = redis.call('INCR', KEYS[5])
if running == 0 then
  redis.call('SET', KEYS[4], 'sweep:' .. ARGV[1], 'PX', ARGV[5])
  return {1, n, 1}
end
return {1, n, 0}
`;

// KEYS: running, hold, admits. ARGV: id, dirty, dirtyHoldMs. Returns the admit count, which says whether anyone joined.
const LUA_RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
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

// KEYS: running. ARGV: id, leaseMs.
const LUA_RENEW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
return 1
`;

type Admission = { gen: number; alone: boolean; local: boolean };

type Keys = typeof BUILD_GATE_KEYS;

/** The Redis store; `keys` is for tests. */
export function redisBuildStore(keys: Keys = BUILD_GATE_KEYS, client = redis): SlotStore<Admission> & {
  release(id: string, dirty: boolean): Promise<number>;
  renew(id: string): Promise<void>;
  claimSweep(id: string): Promise<boolean>;
  endSweep(): Promise<void>;
  runningCount(): Promise<number>;
} {
  return {
    async tryAcquire(id, limit) {
      const [admitted, gen, alone] = (await client.eval(
        LUA_TRY, 5, keys.queue, keys.seen, keys.running, keys.hold, keys.admits,
        id, String(limit), String(LEASE_MS), String(WAITER_LEASE_MS), String(SWEEP_HOLD_MS), String(DIRTY_HOLD_MS),
      )) as number[];
      return admitted === 1 ? { gen, alone: alone === 1, local: false } : null;
    },
    async place(id) {
      try {
        const index = await client.lpos(keys.queue, id);
        return typeof index === "number" ? index : "unknown";
      } catch {
        return "unknown";
      }
    },
    async remove(id) {
      await client.lrem(keys.queue, 0, id);
      await client.hdel(keys.seen, id);
    },
    async release(id, dirty) {
      return Number(await client.eval(LUA_RELEASE, 3, keys.running, keys.hold, keys.admits, id, dirty ? "1" : "0", String(DIRTY_HOLD_MS)));
    },
    async renew(id) {
      await client.eval(LUA_RENEW, 1, keys.running, id, String(LEASE_MS));
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
      return { gen: 0, alone: false, local: true };
    },
    async place(id) {
      const index = queue.indexOf(id);
      return index === -1 ? "unknown" : index;
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
      .select({ peak: max(deployments.buildMemoryPeak) })
      .from(deployments)
      .where(and(isNotNull(deployments.buildMemoryPeak), gt(deployments.startedAt, new Date(Date.now() - PEAK_WINDOW_MS))));
    peakCache = { at: Date.now(), bytes: row?.peak ? Number(row.peak) : null };
  } catch (err) {
    log.warn("Couldn't read recorded build peaks; sizing builds by the default budget:", err);
    peakCache = { at: Date.now(), bytes: null };
  }
  return peakCache.bytes;
}

export type BuildLimitInput = {
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
  return buildLimit({
    limitBytes: bounded.limitBytes ?? 0,
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
export async function sweepOrphanSteps(container: string, opts: { waitMs?: number } = {}): Promise<{ killed: number; clean: boolean } | null> {
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

async function recordPeak(deploymentId: string, bytes: number): Promise<void> {
  await db
    .update(deployments)
    .set({ buildMemoryPeak: sql`greatest(coalesce(${deployments.buildMemoryPeak}, 0), ${bytes})` })
    .where(eq(deployments.id, deploymentId));
  peakCache = { at: 0, bytes: null };
}

export type BuildGate = {
  deploymentId: string;
  log: (line: string) => void;
  wait?: WaitWriter;
  signal?: AbortSignal;
};

/** Runs `build` once the builder has a slot for it. Records the builder's memory peak when the build ran alone. */
export async function withBuildSlot<T>(gate: BuildGate, bounded: BoundedBuild, build: () => Promise<T>): Promise<T> {
  const store = gateStores.redis;
  // A build that retries in the same deploy queues on its own token.
  const id = `${gate.deploymentId}:${Math.random().toString(36).slice(2, 8)}`;
  let latest = await currentLimit(bounded);
  const limit = async () => (latest = await currentLimit(bounded)).limit;

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
    onPosition: (ahead: number) => void gate.wait?.("build-slot", ahead),
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

  let slot = await store.tryAcquire(id, latest.limit).catch((err) => {
    toLocal(err);
    return gateStores.local.tryAcquire(id, latest.limit);
  });
  if (!slot) {
    const running = local ? gateStores.local.runningCount() : await store.runningCount().catch(() => null);
    gate.log(
      `[queue] Waiting for the builder: ${running ?? "?"} running, ${latest.limit} at a time` +
        (latest.pressured ? " (host memory under pressure)" : ""),
    );
    void gate.wait?.("build-slot");
    try {
      slot = local ? await waitForFifoSlot(gateStores.local, id, localOpts()) : await waitForFifoSlot(store, id, waitOpts);
    } finally {
      await gate.wait?.(null);
    }
    gate.log("[queue] Builder free — starting the build");
  }
  return runHeld(slot);

  async function runHeld(held: Admission): Promise<T> {
    if (held.local) {
      try {
        return await build();
      } finally {
        gateStores.local.release(id);
      }
    }

    const renew = setInterval(() => void store.renew(id).catch(() => {}), RENEW_MS);
    renew.unref?.();
    let ok = false;
    let sampler: ReturnType<typeof sampleBuilder> | null = null;
    try {
      if (held.alone) {
        try {
          await sweep(bounded.container, gate.log);
        } finally {
          await store.endSweep().catch(() => {});
        }
        if (bounded.container) sampler = sampleBuilder(bounded.container);
      }
      const result = await build();
      ok = true;
      return result;
    } finally {
      clearInterval(renew);
      const rise = sampler ? await sampler.stop() : null;
      const admits = await store.release(id, !ok).catch(() => null);
      // Alone at admission and nobody admitted since: the builder's rise is this build's.
      if (ok && held.alone && admits === held.gen && rise !== null && rise > 0) {
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
