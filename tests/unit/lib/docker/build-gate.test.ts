import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The build gate: how many builds BuildKit takes at once, the FIFO wait and the sweeper clock, and peak recording.

const { state } = vi.hoisted(() => ({
  state: {
    psi: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    peak: null as number | null,
    recorded: [] as unknown[],
    steps: [] as string[],
    killed: [] as string[],
    anon: [] as number[],
    inspectFails: false,
    clock: [] as string[],
    typical: {} as Record<string, number>,
    meminfo: null as string | null,
    meshLimit: 0,
    buildkitLimit: 0,
    updates: [] as { path: string; body: { Memory: number } }[],
  },
}));

const { ready } = vi.hoisted(() => ({ ready: new Map<string, boolean>() }));
vi.mock("@/lib/docker/build-targets", async (original) => ({
  ...(await original<typeof import("@/lib/docker/build-targets")>()),
  isTargetReady: async (t: { id: string }) => ready.get(t.id) ?? true,
  markTargetDown: (t: { id: string }) => void ready.set(t.id, false),
}));

const { peerSlot } = vi.hoisted(() => ({
  peerSlot: { reply: "granted" as string, calls: [] as string[], stats: [] as ({ oomKills: number | null; limitBytes: number | null } | null)[] },
}));
vi.mock("@/lib/mesh/build-slot", () => ({
  claimPeerSlot: async (peer: string) => {
    peerSlot.calls.push(`claim:${peer}`);
    return peerSlot.reply;
  },
  peerBuilderStats: async (peer: string) => {
    peerSlot.calls.push(`builder:${peer}`);
    return peerSlot.stats.shift() ?? null;
  },
  renewPeerSlot: async (peer: string) => void peerSlot.calls.push(`renew:${peer}`),
  releasePeerSlot: async (peer: string) => void peerSlot.calls.push(`release:${peer}`),
}));

vi.mock("@/lib/deploy/running-clock", () => ({
  pauseRunningClock: (id: string) => {
    state.clock.push(`pause:${id}`);
    return { resume: async () => void state.clock.push(`resume:${id}`) };
  },
}));

vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  readFile: vi.fn(async (path: string) => {
    if (path === "/proc/pressure/memory") return state.psi;
    if (path === "/proc/meminfo" && state.meminfo) return state.meminfo;
    throw new Error("ENOENT");
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ peak: state.peak }] }) }),
    insert: () => ({ values: (values: unknown) => ({ onConflictDoUpdate: async () => void state.recorded.push(values) }) }),
  },
}));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/deploy/eta-history", () => ({
  typicalBuildMs: async (ids: string[]) => new Map(ids.map((id) => [id, state.typical[id] ?? null])),
}));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/resources/host", () => ({
  detectedHost: () => ({ cpus: 8, memoryBytes: 16 * 1024 ** 3 }),
  hostCpuCount: (host: { cpus: number } | null) => host?.cpus ?? 1,
}));
vi.mock("@/lib/docker/client", () => ({
  dockerRequest: vi.fn(async (method: string, path: string, body?: { Memory: number }) => {
    if (method === "POST" && path.endsWith("/update") && body) {
      state.updates.push({ path, body });
      if (path.includes("vardo-mesh-builder")) state.meshLimit = body.Memory;
      return {};
    }
    if (path.endsWith("/json")) {
      if (state.inspectFails) throw new Error("connect ECONNREFUSED /var/run/docker.sock");
      if (path.includes("vardo-mesh-builder") && state.meshLimit) return { HostConfig: { Memory: state.meshLimit } };
      return {};
    }
    return { memory_stats: { stats: { anon: state.anon.shift() ?? 300 * 1024 ** 2 } } };
  }),
}));
vi.mock("@/lib/utils/exec", () => ({
  execFileAsync: vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes("list")) {
      const running = state.steps.filter((s) => !state.killed.includes(s));
      return { stdout: JSON.stringify(running.map((id) => ({ id, status: "running" }))), stderr: "" };
    }
    if (args.includes("kill")) state.killed.push(args[args.indexOf("kill") + 1]);
    if (args[0] === "inspect" && state.buildkitLimit) return { stdout: `${state.buildkitLimit} ${state.buildkitLimit}`, stderr: "" };
    return { stdout: "", stderr: "" };
  }),
}));

const { createBuildPlacement, NO_PLACEMENT } = await import("@/lib/docker/build-placement");
const { buildLimit, parseMemoryPressure, localBuildStore, withBuildSlot, resetBuildGateForTests, buildEta, recordablePeak, claimSlotForPeer, releaseSlotForPeer, sizeMeshBuilder, targetSlotView } = await import(
  "@/lib/docker/build-gate"
);

type RedisStore = ReturnType<typeof import("@/lib/docker/build-gate").redisBuildStore>;

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const GB = 1e9;
const jy0 = { limitBytes: 6 * GiB, hostMemoryBytes: 32 * GiB, cpus: 8, memoryPressureAvg10: 0, env: {} };

describe("buildLimit", () => {
  it("runs a 3.2 GB build alone on jy0", () => {
    expect(buildLimit({ ...jy0, largestPeakBytes: 3.2 * GB }).limit).toBe(1);
  });

  it("runs two 2.5 GB builds together on jy0", () => {
    expect(buildLimit({ ...jy0, largestPeakBytes: 2.5 * GB }).limit).toBe(2);
  });

  it("sizes builds at 3 GiB until a peak is recorded", () => {
    expect(buildLimit({ ...jy0, largestPeakBytes: null }).budgetBytes).toBe(3 * GiB);
    expect(buildLimit({ ...jy0, limitBytes: 16 * GiB, largestPeakBytes: null }).limit).toBe(2);
  });

  it("caps builds at one per four cores", () => {
    expect(buildLimit({ ...jy0, limitBytes: 64 * GiB, largestPeakBytes: 1 * GB }).limit).toBe(2);
    expect(buildLimit({ ...jy0, cpus: 16, limitBytes: 64 * GiB, largestPeakBytes: 1 * GB }).limit).toBe(4);
  });

  it("never drops below one, even when a peak exceeds the builder", () => {
    expect(buildLimit({ ...jy0, largestPeakBytes: 9 * GiB }).limit).toBe(1);
    expect(buildLimit({ ...jy0, cpus: 2, largestPeakBytes: 1 * GB }).limit).toBe(1);
  });

  it("uses half the host's memory when BuildKit has no limit", () => {
    const out = buildLimit({ ...jy0, limitBytes: 0, hostMemoryBytes: 16 * GiB, largestPeakBytes: 2 * GiB });
    expect(out.usableBytes).toBe(8 * GiB);
    expect(out.limit).toBe(2);
  });

  it("drops to one build under memory pressure", () => {
    const out = buildLimit({ ...jy0, largestPeakBytes: 1 * GB, memoryPressureAvg10: 35 });
    expect(out).toMatchObject({ limit: 1, pressured: true });
  });

  it("takes VARDO_MAX_CONCURRENT_BUILDS over the rule, but not over memory pressure", () => {
    const env = { VARDO_MAX_CONCURRENT_BUILDS: "3" };
    expect(buildLimit({ ...jy0, largestPeakBytes: 3.2 * GB, env }).limit).toBe(3);
    expect(buildLimit({ ...jy0, largestPeakBytes: 3.2 * GB, env, memoryPressureAvg10: 50 }).limit).toBe(1);
    expect(buildLimit({ ...jy0, largestPeakBytes: 3.2 * GB, env: { VARDO_MAX_CONCURRENT_BUILDS: "0" } }).limit).toBe(1);
  });

  it("never gives zero builds when nothing about the builder or host reads", () => {
    const blank = { limitBytes: 0, hostMemoryBytes: 0, cpus: 0, largestPeakBytes: null, memoryPressureAvg10: null, env: {} };
    expect(buildLimit(blank).limit).toBe(1);
    expect(buildLimit({ ...blank, hostMemoryBytes: NaN, cpus: NaN }).limit).toBe(1);
  });
});

describe("recordablePeak", () => {
  it("keeps a real build's rise", () => {
    expect(recordablePeak(2 * GiB, 90_000)).toBe(true);
  });

  it("drops a zero or negligible rise, a near-instant build and a missing sample", () => {
    expect(recordablePeak(0, 90_000)).toBe(false);
    expect(recordablePeak(20 * MiB, 90_000)).toBe(false);
    expect(recordablePeak(2 * GiB, 1_000)).toBe(false);
    expect(recordablePeak(null, 90_000)).toBe(false);
  });
});

describe("buildEta", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const min = 60_000;
  const snapshot = (queue: string[], running: { id: string; since: number | null }[]) => ({ snapshot: async () => ({ queue, running }) });

  beforeEach(() => {
    state.typical = { a: 10 * min, b: 4 * min, c: 6 * min };
  });

  it("starts when the running build should end, then after each build ahead", async () => {
    const store = snapshot(["b:1", "c:1", "d:1"], [{ id: "a:1", since: now - 6 * min }]);
    expect(await buildEta(store, "b:1", 1, now)).toBe(now + 4 * min);
    expect(await buildEta(store, "c:1", 1, now)).toBe(now + 8 * min);
    expect(await buildEta(store, "d:1", 1, now)).toBe(now + 14 * min);
  });

  it("takes the earliest of two slots", async () => {
    const store = snapshot(["b:1", "c:1"], [{ id: "a:1", since: now - 6 * min }]);
    expect(await buildEta(store, "b:1", 2, now)).toBe(now);
    expect(await buildEta(store, "c:1", 2, now)).toBe(now + 4 * min);
  });

  it("counts an overdue build as ending now", async () => {
    const store = snapshot(["b:1"], [{ id: "a:1", since: now - 30 * min }]);
    expect(await buildEta(store, "b:1", 1, now)).toBe(now);
  });

  it("is null for a deploy queued behind a running build without history, with or without an admission time", async () => {
    expect(await buildEta(snapshot(["b:1"], [{ id: "x:1", since: now - 2 * min }]), "b:1", 1, now)).toBeNull();
    expect(await buildEta(snapshot(["b:1"], [{ id: "a:1", since: null }]), "b:1", 1, now)).toBeNull();
    // A free slot beside it doesn't help the second in line, which may follow either.
    expect(await buildEta(snapshot(["b:1", "c:1"], [{ id: "x:1", since: now - 2 * min }]), "c:1", 2, now)).toBeNull();
  });

  it("is null behind a build without history or without a deployment", async () => {
    expect(await buildEta(snapshot(["x:1", "b:1"], []), "b:1", 1, now)).toBeNull();
    expect(await buildEta(snapshot(["b:1"], [{ id: "build:zz", since: now }]), "b:1", 1, now)).toBeNull();
    expect(await buildEta(snapshot(["b:1"], []), "gone:1", 1, now)).toBeNull();
  });
});

describe("parseMemoryPressure", () => {
  it("reads some avg10", () => {
    expect(parseMemoryPressure("some avg10=12.50 avg60=3.00 avg300=1.00 total=9\nfull avg10=40.00 avg60=0 avg300=0 total=1")).toBe(12.5);
  });

  it("is null without PSI", () => {
    expect(parseMemoryPressure("")).toBeNull();
  });
});

describe("localBuildStore", () => {
  it("admits in arrival order, so a build queued first isn't passed by later ones", async () => {
    const store = localBuildStore();
    expect(await store.tryAcquire("big-running", 1)).not.toBeNull();
    expect(await store.tryAcquire("c", 1)).toBeNull();
    expect(await store.tryAcquire("d", 1)).toBeNull();
    store.release("big-running");
    // d polls first but c heads the queue.
    expect(await store.tryAcquire("d", 1)).toBeNull();
    expect(await store.tryAcquire("c", 1)).not.toBeNull();
  });

  it("always admits into an idle builder", async () => {
    const store = localBuildStore();
    expect(await store.tryAcquire("a", 1)).not.toBeNull();
  });
});

/** The Redis store's semantics in memory: FIFO head, uniform slots, a sweep hold for the first build into an idle builder. */
function fakeRedisStore() {
  const queue: string[] = [];
  const running = new Set<string>();
  let hold: string | null = null;
  let admits = 0;
  const targetRunning: Record<string, Set<string>> = {};
  const full = new Set<string>();
  const store = {
    async tryAcquire(id: string, limit: number) {
      if (!queue.includes(id)) queue.push(id);
      if (queue[0] !== id || hold?.startsWith("sweep:")) return null;
      if (running.size > 0 && (hold || running.size >= limit)) return null;
      queue.shift();
      running.add(id);
      admits++;
      const alone = running.size === 1;
      if (alone) hold = `sweep:${id}`;
      return { gen: admits, alone, local: false, target: null };
    },
    async tryAcquireAt(id: string, limit: number, slots: { id: string; limit: number }[]) {
      const here = await store.tryAcquire(id, limit);
      if (here || slots.length === 0) return here;
      for (const slot of slots) {
        const set = (targetRunning[slot.id] ??= new Set());
        if (set.size < slot.limit) {
          queue.splice(queue.indexOf(id), 1);
          set.add(id);
          return { gen: 0, alone: false, local: false, target: slot.id };
        }
      }
      return null;
    },
    async releaseTarget(id: string, target: string) {
      targetRunning[target]?.delete(id);
    },
    async place(id: string) {
      const i = queue.indexOf(id);
      return i === -1 ? ("unknown" as const) : { ahead: i, total: queue.length };
    },
    async remove(id: string) {
      const i = queue.indexOf(id);
      if (i !== -1) queue.splice(i, 1);
    },
    async release(id: string, dirty: boolean) {
      running.delete(id);
      if (dirty && !hold?.startsWith("sweep:")) hold = "dirty";
      return admits;
    },
    async renew() {},
    async renewHeld(id: string) {
      return running.has(id);
    },
    async markFull(target: string) {
      full.add(target);
    },
    async fullTargets(ids: string[]) {
      return new Set(ids.filter((id) => full.has(id)));
    },
    async readyTargets() {
      return null;
    },
    async setReadyTargets() {},
    async targetHolders(ids: string[]) {
      return ids.flatMap((id) => [...(targetRunning[id] ?? [])]);
    },
    async claimSweep(id: string) {
      if (running.size > 0 || hold?.startsWith("sweep:")) return false;
      hold = `sweep:${id}`;
      return true;
    },
    async endSweep() {
      hold = null;
    },
    async runningCount() {
      return running.size;
    },
    async snapshot() {
      return { queue: [...queue], running: [...running].map((id) => ({ id, since: null })) };
    },
    async bump() {
      return false;
    },
    queue,
    targetRunning,
    full,
    running,
    hold: () => hold,
  };
  return store as unknown as RedisStore & {
    queue: string[];
    targetRunning: Record<string, Set<string>>;
    full: Set<string>;
    running: Set<string>;
    hold: () => string | null;
  };
}

const bounded = { env: {}, loadArgs: [], limitBytes: 6 * GiB, container: "vardo-buildkit" };

function gateFor(deploymentId: string | undefined, signal?: AbortSignal) {
  const lines: string[] = [];
  return {
    lines,
    gate: {
      deploymentId,
      log: (line: string) => void lines.push(line),
      signal,
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("withBuildSlot", () => {
  let store: ReturnType<typeof fakeRedisStore>;

  beforeEach(() => {
    store = fakeRedisStore();
    resetBuildGateForTests(store);
    Object.assign(state, { peak: 3.2 * GB, recorded: [], steps: [], killed: [], anon: [], inspectFails: false, clock: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("neither queues nor pauses the clock for a build that gets the builder straight away", async () => {
    const a = gateFor("dep-a");
    await withBuildSlot(a.gate, bounded, async () => {});
    expect(state.clock).toEqual([]);
    expect(a.lines.some((l) => l.startsWith("[queue]"))).toBe(false);
  });

  it("queues a second build behind the first, says why and pauses its clock while it waits", async () => {
    const first = deferred();
    const a = gateFor("dep-a");
    const running = withBuildSlot(a.gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const b = gateFor("dep-b");
    let started = false;
    const queued = withBuildSlot(b.gate, bounded, async () => void (started = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(false);
    expect(b.lines).toContain("[queue] Waiting for the builder: 1 running, 1 at a time");
    expect(state.clock).toEqual(["pause:dep-b"]);

    first.resolve();
    await running;
    await queued;
    expect(started).toBe(true);
    expect(state.clock).toEqual(["pause:dep-b", "resume:dep-b"]);
    expect(b.lines).toContain("[queue] Builder free, starting build");
  });

  it("resumes the clock and leaves the queue when the deploy is cancelled", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const controller = new AbortController();
    const b = gateFor("dep-b", controller.signal);
    const queued = withBuildSlot(b.gate, bounded, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    await expect(queued).rejects.toThrow("Deployment aborted");
    expect(state.clock).toEqual(["pause:dep-b", "resume:dep-b"]);
    expect(store.queue).toEqual([]);
    first.resolve();
    await running;
  });

  it("opens a build-slot wait with the deploy's place and the line's length and ends it, leaving the clock to the wait writer", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const waits: unknown[] = [];
    const b = gateFor("dep-b");
    const queued = withBuildSlot(
      { ...b.gate, wait: async (reason, place) => void waits.push([reason, place?.ahead, place?.total]) },
      bounded,
      async () => {},
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toEqual(["build-slot", undefined, undefined]);
    expect(waits).toContainEqual(["build-slot", 0, 1]);

    first.resolve();
    await Promise.all([running, queued]);
    expect(waits.at(-1)).toEqual([null, undefined, undefined]);
    expect(state.clock).toEqual([]);
  });

  it("ends the wait when a waiting deploy is cancelled", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const waits: unknown[] = [];
    const controller = new AbortController();
    const b = gateFor("dep-b", controller.signal);
    const queued = withBuildSlot({ ...b.gate, wait: async (reason) => void waits.push(reason) }, bounded, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(queued).rejects.toThrow("Deployment aborted");
    expect(waits.at(-1)).toBeNull();
    first.resolve();
    await running;
  });

  it("gates a build without a deployment but records nothing for it", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor(undefined).gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    const queued = withBuildSlot(gateFor(undefined).gate, bounded, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(store.queue).toHaveLength(1);
    first.resolve();
    await Promise.all([running, queued]);
    expect(state.clock).toEqual([]);
    expect(state.recorded).toHaveLength(0);
  });

  it("stops steps an earlier build left running before a build into an idle builder", async () => {
    state.steps = ["orphan1", "orphan2"];
    const a = gateFor("dep-a");
    await withBuildSlot(a.gate, bounded, async () => {});
    expect(state.killed).toEqual(["orphan1", "orphan2"]);
    expect(a.lines.some((l) => l.includes("Stopped 2 build step(s)"))).toBe(true);
  });

  /** A build that takes `ms` by the clock, without waiting that long. */
  const takes = (ms: number) => async () => {
    vi.setSystemTime(Date.now() + ms);
  };

  it("records the builder's rise for a build that ran alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.anon = [400 * MiB, 2400 * MiB];
    const placement = createBuildPlacement();
    await withBuildSlot({ ...gateFor("dep-a").gate, placement }, bounded, takes(90_000));
    expect(state.recorded).toEqual([{ deploymentId: "dep-a", peakBytes: 2000 * MiB }]);
    expect(placement.columns()).toMatchObject({ buildOutcome: "here", buildPeakBytes: 2000 * MiB });
  });

  it("records nothing for a near-instant build, such as one served from the cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.anon = [400 * MiB, 2400 * MiB];
    await withBuildSlot(gateFor("dep-a").gate, bounded, takes(1_000));
    expect(state.recorded).toHaveLength(0);
  });

  it("records nothing when the builder barely rose", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.anon = [400 * MiB, 400 * MiB];
    await withBuildSlot(gateFor("dep-a").gate, bounded, takes(90_000));
    state.anon = [400 * MiB, 410 * MiB];
    await withBuildSlot(gateFor("dep-b").gate, bounded, takes(90_000));
    expect(state.recorded).toHaveLength(0);
  });

  it("sizes builds by the default budget when the largest recorded peak is zero or negligible", async () => {
    for (const peak of [0, 2 * MiB]) {
      resetBuildGateForTests(store);
      state.peak = peak;
      const first = deferred();
      const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
      await new Promise((r) => setTimeout(r, 10));
      const b = gateFor("dep-b");
      const queued = withBuildSlot(b.gate, bounded, async () => {});
      await new Promise((r) => setTimeout(r, 20));
      // A tiny budget would let every core's share in at once: 2 at a time on this host.
      expect(b.lines).toContain("[queue] Waiting for the builder: 1 running, 1 at a time");
      first.resolve();
      await Promise.all([running, queued]);
    }
  });

  it("sizes by the limit it started with when BuildKit's live limit can't be read, and still admits builds", async () => {
    state.inspectFails = true;
    const unreadable = { ...bounded, container: "vardo-buildkit-unreadable" };
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, unreadable, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    const b = gateFor("dep-b");
    let started = false;
    const queued = withBuildSlot(b.gate, unreadable, async () => void (started = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(b.lines).toContain("[queue] Waiting for the builder: 1 running, 1 at a time");
    first.resolve();
    await Promise.all([running, queued]);
    expect(started).toBe(true);
  });

  it("falls back to the host's share when neither the live nor the starting limit is known", async () => {
    state.inspectFails = true;
    const unknown = { ...bounded, limitBytes: null, container: "vardo-buildkit-unknown" };
    let ran = 0;
    await Promise.all([
      withBuildSlot(gateFor("dep-a").gate, unknown, async () => void ran++),
      withBuildSlot(gateFor("dep-b").gate, unknown, async () => void ran++),
    ]);
    expect(ran).toBe(2);
  });

  it("records nothing when another build joined while it ran", async () => {
    state.peak = 1 * GB;
    const first = deferred();
    const placement = createBuildPlacement();
    const a = withBuildSlot({ ...gateFor("dep-a").gate, placement }, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    const b = withBuildSlot(gateFor("dep-b").gate, bounded, async () => {});
    await b;
    first.resolve();
    await a;
    expect(state.recorded).toHaveLength(0);
    expect(placement.columns()).toMatchObject({ buildOutcome: "here", buildPeakBytes: null });
  });

  it("clears an idle builder after a build fails", async () => {
    state.steps = [];
    await expect(
      withBuildSlot(gateFor("dep-a").gate, bounded, async () => {
        state.steps = ["left-behind"];
        throw new Error("docker timed out after 2400s");
      }),
    ).rejects.toThrow(/timed out/);
    expect(state.killed).toEqual(["left-behind"]);
    expect(state.recorded).toHaveLength(0);
  });
});

describe("withBuildSlot with build targets", async () => {
  let store: ReturnType<typeof fakeRedisStore>;
  const { BuilderError } = await import("@/lib/docker/build-targets");

  const target = (id: string, maxConcurrent = 1) => ({
    id, kind: "ssh" as const, name: id, host: `${id}.example.com`, port: 22, user: "vardo",
    privateKey: "key", hostKey: `${id}.example.com ssh-ed25519 AAAA`, maxConcurrent,
  });

  beforeEach(() => {
    store = fakeRedisStore();
    resetBuildGateForTests(store);
    ready.clear();
    Object.assign(state, { peak: 3.2 * GB, recorded: [], steps: [], killed: [], anon: [], inspectFails: false, clock: [] });
  });

  it("builds here while this host has a slot, and says so", async () => {
    const a = gateFor("dep-a");
    const placement = createBuildPlacement();
    let where: unknown = "unset";
    await withBuildSlot({ ...a.gate, targets: [target("lh")], placement }, bounded, async ({ target }) => void (where = target));
    expect(where).toBeNull();
    expect(a.lines).toContain("[build] Building on this server");
    expect(placement.columns()).toEqual({ ...NO_PLACEMENT, buildOutcome: "here" });
  });

  it("overflows to the first target with a free slot when this host is busy", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const lh = target("lh", 1);
    const hz = target("hz", 2);
    const b = gateFor("dep-b");
    const c = gateFor("dep-c");
    const busy = deferred();
    const on: string[] = [];
    const placement = createBuildPlacement();
    const queuedB = withBuildSlot({ ...b.gate, targets: [lh, hz], placement }, bounded, async ({ target }) => {
      on.push(`b:${target?.id}`);
      await busy.promise;
    });
    await new Promise((r) => setTimeout(r, 1200));
    const queuedC = withBuildSlot({ ...c.gate, targets: [lh, hz] }, bounded, async ({ target }) => void on.push(`c:${target?.id}`));
    await new Promise((r) => setTimeout(r, 1500));
    expect(on).toEqual(["b:lh", "c:hz"]);
    expect(b.lines).toContain("[build] Building on lh (vardo@lh.example.com:22)");
    expect(placement.columns()).toMatchObject({ buildTargetId: "lh", buildTargetName: "lh", buildOutcome: "target", buildFallbackReason: null });
    busy.resolve();
    first.resolve();
    await Promise.all([running, queuedB, queuedC]);
    expect(store.targetRunning.lh.size).toBe(0);
  });

  it("skips a target that isn't answering", async () => {
    ready.set("lh", false);
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    let where: unknown = "unset";
    const queued = withBuildSlot({ ...gateFor("dep-b").gate, targets: [target("lh")] }, bounded, async ({ target }) => void (where = target?.id ?? null));
    await new Promise((r) => setTimeout(r, 1200));
    expect(where).toBe("unset");
    first.resolve();
    await Promise.all([running, queued]);
    expect(where).toBeNull();
  });

  it("builds here once after a builder failure on the target, and logs why", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    const b = gateFor("dep-b");
    const on: (string | null)[] = [];
    const placement = createBuildPlacement();
    const queued = withBuildSlot({ ...b.gate, targets: [target("lh")], placement }, bounded, async ({ target }) => {
      on.push(target?.id ?? null);
      if (target) throw new BuilderError("it's unreachable");
    });
    await new Promise((r) => setTimeout(r, 1200));
    first.resolve();
    await Promise.all([running, queued]);
    expect(on).toEqual(["lh", null]);
    expect(b.lines).toContain("[build] lh couldn't build: it's unreachable. Building on this server instead");
    expect(placement.columns()).toMatchObject({ buildTargetId: "lh", buildOutcome: "fallback", buildFallbackReason: "it's unreachable", imageTransfer: null });
    expect(ready.get("lh")).toBe(false);
  });

  it("doesn't retry a build the app's own code failed", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    let runs = 0;
    const queued = withBuildSlot({ ...gateFor("dep-b").gate, targets: [target("lh")] }, bounded, async () => {
      runs++;
      throw new Error('failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1');
    });
    await expect(queued).rejects.toThrow(/npm run build/);
    first.resolve();
    await running;
    expect(runs).toBe(1);
  });
});

describe("withBuildSlot on a linked instance", () => {
  let store: ReturnType<typeof fakeRedisStore>;
  const mesh = (id: string) => ({
    id: `mesh-${id}`, kind: "mesh" as const, peerId: id, name: "Long House", host: "10.99.0.2", port: 2222, user: "vardo-mesh",
    privateKey: "key", hostKey: "[10.99.0.2]:2222 ssh-ed25519 AAAA", maxConcurrent: 1,
  });

  beforeEach(() => {
    store = fakeRedisStore();
    resetBuildGateForTests(store);
    ready.clear();
    peerSlot.reply = "granted";
    peerSlot.calls.length = 0;
    Object.assign(state, { peak: 3.2 * GB, recorded: [], steps: [], killed: [], anon: [], inspectFails: false, clock: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Holds this host's only slot until `resolve` runs. */
  async function busyHere() {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-here").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    return { running, resolve: first.resolve };
  }

  it("takes a slot in the peer's gate before building there, renews it with the target's and gives it back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const here = await busyHere();
    const b = gateFor("dep-b");
    await withBuildSlot({ ...b.gate, targets: [mesh("lh")] }, bounded, async ({ target }) => {
      expect(target?.id).toBe("mesh-lh");
      expect(peerSlot.calls).toEqual(["claim:lh"]);
      vi.advanceTimersByTime(10_000);
    });
    here.resolve();
    await here.running;
    expect(peerSlot.calls).toEqual(["claim:lh", "renew:lh", "release:lh"]);
    expect(b.lines).toContain("[build] Building on Long House (vardo-mesh@10.99.0.2:2222)");
  });

  it("waits for this host instead of building alongside a full peer's own builds", async () => {
    peerSlot.reply = "full";
    const here = await busyHere();
    const b = gateFor("dep-b");
    const where: (string | null)[] = [];
    const queued = withBuildSlot({ ...b.gate, targets: [mesh("lh")] }, bounded, async ({ target }) => void where.push(target?.id ?? null));
    await new Promise((r) => setTimeout(r, 1200));
    expect(where).toEqual([]);
    expect(store.full.has("mesh-lh")).toBe(true);
    expect(store.targetRunning["mesh-lh"]?.size ?? 0).toBe(0);
    expect(b.lines.filter((l) => l.includes("builder is full"))).toEqual(["[queue] Long House's builder is full; waiting for a free slot"]);
    here.resolve();
    await Promise.all([here.running, queued]);
    expect(where).toEqual([null]);
    expect(peerSlot.calls).toEqual(["claim:lh"]);
  });

  it("builds on an older peer without the endpoint as before, with nothing to renew or release", async () => {
    peerSlot.reply = "unsupported";
    const here = await busyHere();
    const b = gateFor("dep-b");
    let where: string | null = null;
    await withBuildSlot({ ...b.gate, targets: [mesh("old")] }, bounded, async ({ target }) => void (where = target?.id ?? null));
    here.resolve();
    await here.running;
    expect(where).toBe("mesh-old");
    expect(peerSlot.calls).toEqual(["claim:old"]);
    expect(b.lines.some((l) => l.includes("build queue"))).toBe(false);
  });

  it("never asks a plain SSH target for a slot", async () => {
    const here = await busyHere();
    await withBuildSlot({ ...gateFor("dep-b").gate, targets: [{ ...mesh("lh"), kind: "ssh" as const, peerId: undefined }] }, bounded, async () => {});
    here.resolve();
    await here.running;
    expect(peerSlot.calls).toEqual([]);
  });

  describe("on the peer's isolated builder", () => {
    const isolated = () => ({ ...mesh("lh"), builder: { host: "10.99.0.2", port: 1234, serverName: "vardo-mesh-builder", ca: "ca", cert: "cert", key: "key" } });
    const pnpmKilled = new Error('docker failed (exit 1): #17 13.57  ELIFECYCLE  Command failed.\nERROR: failed to build: failed to solve: process "/bin/sh -c pnpm run build" did not complete successfully: exit code: 1');

    beforeEach(() => {
      peerSlot.stats.length = 0;
    });

    it("builds here when the peer's builder OOM-killed the build, and names the cause", async () => {
      peerSlot.stats.push({ oomKills: 2, limitBytes: 4 * GiB }, { oomKills: 3, limitBytes: 4 * GiB });
      const here = await busyHere();
      const b = gateFor("dep-b");
      const where: (string | null)[] = [];
      const queued = withBuildSlot({ ...b.gate, targets: [isolated()] }, bounded, async ({ target }) => {
        where.push(target?.id ?? null);
        if (target) throw pnpmKilled;
      });
      await new Promise((r) => setTimeout(r, 50));
      here.resolve();
      await Promise.all([here.running, queued]);
      expect(where).toEqual(["mesh-lh", null]);
      expect(b.lines).toContain("[build] Ran out of memory in Long House's isolated builder (4 GiB). Building on this server instead");
      expect(peerSlot.calls).toEqual(["claim:lh", "builder:lh", "builder:lh", "release:lh"]);
      expect(ready.get("mesh-lh")).toBeUndefined();
    });

    it("fails an ordinary build failure there without building again here", async () => {
      peerSlot.stats.push({ oomKills: 2, limitBytes: 4 * GiB }, { oomKills: 2, limitBytes: 4 * GiB });
      const here = await busyHere();
      const b = gateFor("dep-b");
      let runs = 0;
      const queued = withBuildSlot({ ...b.gate, targets: [isolated()] }, bounded, async () => {
        runs++;
        throw new Error('failed to solve: process "/bin/sh -c pnpm run build" did not complete successfully: exit code: 137');
      });
      await expect(queued).rejects.toThrow(/exit code: 137/);
      here.resolve();
      await here.running;
      expect(runs).toBe(1);
      expect(b.lines.some((l) => l.includes("out of memory"))).toBe(false);
    });

    it("goes by BuildKit's error when the peer can't report its kills", async () => {
      const here = await busyHere();
      const b = gateFor("dep-b");
      const where: (string | null)[] = [];
      const queued = withBuildSlot({ ...b.gate, targets: [isolated()] }, bounded, async ({ target }) => {
        where.push(target?.id ?? null);
        if (target) throw new Error('failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137');
      });
      await new Promise((r) => setTimeout(r, 50));
      here.resolve();
      await Promise.all([here.running, queued]);
      expect(where).toEqual(["mesh-lh", null]);
      expect(b.lines).toContain("[build] Ran out of memory in Long House's isolated builder. Building on this server instead");
    });
  });

  it("leaves a full peer out of the queue's target slots", async () => {
    const lh = mesh("lh");
    const load = async () => [lh];
    expect((await targetSlotView({ load, check: async () => true })).slots).toBe(1);
    await store.markFull(lh.id);
    resetBuildGateForTests(store);
    expect((await targetSlotView({ load, check: async () => true })).slots).toBe(0);
  });
});

describe("claimSlotForPeer", () => {
  let store: ReturnType<typeof fakeRedisStore>;

  beforeEach(() => {
    store = fakeRedisStore();
    resetBuildGateForTests(store);
    Object.assign(state, { peak: 3.2 * GB, recorded: [], steps: [], killed: [], anon: [], inspectFails: false, clock: [] });
  });

  it("takes a free slot here without holding the builder for a sweep", async () => {
    expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
    expect(store.running.has("build:mesh-jy0-a")).toBe(true);
    expect(store.hold()).toBeNull();
  });

  it("refuses while this host is full and leaves nothing queued ahead of its own builds", async () => {
    state.peak = 9 * GiB;
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-own").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(false);
    expect(store.queue).toEqual([]);
    expect(store.running.has("build:mesh-jy0-a")).toBe(false);
    first.resolve();
    await running;
  });

  describe("with both builders at 12 GiB on a 48 GiB host", () => {
    const meminfo = (availableGiB: number) => `MemTotal: ${48 * 1024 * 1024} kB\nMemAvailable: ${availableGiB * 1024 * 1024} kB\n`;

    let skew = 0;
    beforeEach(() => {
      Object.assign(state, { meshLimit: 12 * GiB, buildkitLimit: 12 * GiB, peak: null });
      // Past the builder limit cache.
      skew += 60_000;
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + skew });
    });
    afterEach(() => {
      vi.useRealTimers();
      Object.assign(state, { meminfo: null, meshLimit: 0, buildkitLimit: 0 });
    });

    it("takes a peer's build beside this host's while both fit in free memory", async () => {
      state.meminfo = meminfo(30);
      const first = deferred();
      const running = withBuildSlot(gateFor("dep-own").gate, bounded, () => first.promise);
      await new Promise((r) => setTimeout(r, 10));
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
      first.resolve();
      await running;
    });

    it("refuses a peer's build that could push both builders into the apps' reserve", async () => {
      state.meminfo = meminfo(20);
      const first = deferred();
      const running = withBuildSlot(gateFor("dep-own").gate, bounded, () => first.promise);
      await new Promise((r) => setTimeout(r, 10));
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(false);
      expect(store.running.has("build:mesh-jy0-a")).toBe(false);
      first.resolve();
      await running;
    });

    it("takes it with the same free memory once this host's builds are done", async () => {
      state.meminfo = meminfo(20);
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
    });

    const ANON = 300 * MiB;
    const step = (bytes: number) => Math.floor(bytes / (64 * MiB)) * 64 * MiB;
    const meshUpdates = () => state.updates.filter((u) => u.path.includes("vardo-mesh-builder")).map((u) => u.body.Memory);
    const big = { ...bounded, limitBytes: 12 * GiB };

    it("sizes the isolated builder like vardo-buildkit without waiting for a peer's build", async () => {
      state.updates = [];
      state.meminfo = meminfo(30);
      expect(await sizeMeshBuilder(() => {})).toBe(24 * GiB);
      expect(meshUpdates()).toEqual([24 * GiB]);
    });

    it("sizes it on a claim beside this host's builds, leaving them their headroom", async () => {
      state.updates = [];
      state.meminfo = meminfo(30);
      const first = deferred();
      const running = withBuildSlot(gateFor("dep-own").gate, bounded, () => first.promise);
      await new Promise((r) => setTimeout(r, 10));
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
      expect(meshUpdates()).toEqual([step(30 * GiB + ANON - 4.8 * GiB - (12 * GiB - ANON))]);
      first.resolve();
      await running;
    });

    it("grows it during a peer's build but shrinks it only once that build is done", async () => {
      state.updates = [];
      state.meminfo = meminfo(30);
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
      expect(meshUpdates()).toEqual([24 * GiB]);
      state.meminfo = meminfo(10);
      expect(await sizeMeshBuilder(() => {})).toBeNull();
      expect(meshUpdates()).toEqual([24 * GiB]);
      await releaseSlotForPeer("build:mesh-jy0-a");
      expect(await sizeMeshBuilder(() => {})).toBe(step(10 * GiB + ANON - 4.8 * GiB));
    });

    it("holds this host's build while a peer's runs and both builders can't fit", async () => {
      state.meminfo = meminfo(20);
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
      const { gate, lines } = gateFor("dep-own");
      let started = false;
      const running = withBuildSlot(gate, big, async () => void (started = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(started).toBe(false);
      expect(lines[0]).toBe("[queue] Waiting for the builder: 1 running, and a linked instance's build here needs the memory");
      await releaseSlotForPeer("build:mesh-jy0-a");
      await running;
      expect(started).toBe(true);
    });

    it("lets it join a peer's build when both fit", async () => {
      state.meminfo = meminfo(44);
      expect(await claimSlotForPeer("build:mesh-jy0-a")).toBe(true);
      let started = false;
      await withBuildSlot(gateFor("dep-own").gate, big, async () => void (started = true));
      expect(started).toBe(true);
    });
  });
});
