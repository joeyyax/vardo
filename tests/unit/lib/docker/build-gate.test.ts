import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The build gate: how many builds BuildKit takes at once, the FIFO wait and its wait entries, and peak recording.

const { state } = vi.hoisted(() => ({
  state: {
    psi: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    peak: null as number | null,
    recorded: [] as unknown[],
    steps: [] as string[],
    killed: [] as string[],
    anon: [100, 400, 900, 300],
  },
}));

vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  readFile: vi.fn(async (path: string) => {
    if (path === "/proc/pressure/memory") return state.psi;
    throw new Error("ENOENT");
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ peak: state.peak }] }) }),
    update: () => ({ set: (values: unknown) => ({ where: async () => void state.recorded.push(values) }) }),
  },
}));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/resources/host", () => ({
  detectedHost: () => ({ cpus: 8, memoryBytes: 16 * 1024 ** 3 }),
  hostCpuCount: (host: { cpus: number } | null) => host?.cpus ?? 1,
}));
vi.mock("@/lib/docker/client", () => ({
  dockerRequest: vi.fn(async () => ({ memory_stats: { stats: { anon: state.anon.shift() ?? 300 } } })),
}));
vi.mock("@/lib/utils/exec", () => ({
  execFileAsync: vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes("list")) {
      const running = state.steps.filter((s) => !state.killed.includes(s));
      return { stdout: JSON.stringify(running.map((id) => ({ id, status: "running" }))), stderr: "" };
    }
    if (args.includes("kill")) state.killed.push(args[args.indexOf("kill") + 1]);
    return { stdout: "", stderr: "" };
  }),
}));

const { buildLimit, parseMemoryPressure, localBuildStore, withBuildSlot, resetBuildGateForTests } = await import(
  "@/lib/docker/build-gate"
);

type RedisStore = ReturnType<typeof import("@/lib/docker/build-gate").redisBuildStore>;

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
      return { gen: admits, alone, local: false };
    },
    async place(id: string) {
      const i = queue.indexOf(id);
      return i === -1 ? ("unknown" as const) : i;
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
    queue,
  };
  return store as unknown as RedisStore & { queue: string[] };
}

const bounded = { env: {}, loadArgs: [], limitBytes: 6 * GiB, container: "vardo-buildkit" };

function gateFor(deploymentId: string, signal?: AbortSignal) {
  const lines: string[] = [];
  const waits: (string | null)[] = [];
  return {
    lines,
    waits,
    gate: {
      deploymentId,
      log: (line: string) => void lines.push(line),
      wait: (reason: string | null, ahead?: number) => void waits.push(reason === null ? null : ahead === undefined ? reason : `${reason}:${ahead}`),
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
    Object.assign(state, { peak: 3.2 * GB, recorded: [], steps: [], killed: [], anon: [100, 400, 900, 300] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes no wait for a build that gets the builder straight away", async () => {
    const a = gateFor("dep-a");
    await withBuildSlot(a.gate, bounded, async () => {});
    expect(a.waits).toEqual([]);
  });

  it("queues a second build behind the first, says why and ends the wait when it starts", async () => {
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

    first.resolve();
    await running;
    await queued;
    expect(started).toBe(true);
    expect(b.waits).toEqual(["build-slot", "build-slot:0", null]);
    expect(b.lines).toContain("[queue] Builder free — starting the build");
  });

  it("ends the wait and leaves the queue when the deploy is cancelled", async () => {
    const first = deferred();
    const running = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));

    const controller = new AbortController();
    const b = gateFor("dep-b", controller.signal);
    const queued = withBuildSlot(b.gate, bounded, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    await expect(queued).rejects.toThrow("Deployment aborted");
    expect(b.waits.at(0)).toBe("build-slot");
    expect(b.waits.at(-1)).toBeNull();
    expect(store.queue).toEqual([]);
    first.resolve();
    await running;
  });

  it("stops steps an earlier build left running before a build into an idle builder", async () => {
    state.steps = ["orphan1", "orphan2"];
    const a = gateFor("dep-a");
    await withBuildSlot(a.gate, bounded, async () => {});
    expect(state.killed).toEqual(["orphan1", "orphan2"]);
    expect(a.lines.some((l) => l.includes("Stopped 2 build step(s)"))).toBe(true);
  });

  it("records the builder's rise for a build that ran alone", async () => {
    await withBuildSlot(gateFor("dep-a").gate, bounded, async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(state.recorded).toHaveLength(1);
  });

  it("records nothing when another build joined while it ran", async () => {
    state.peak = 1 * GB;
    const first = deferred();
    const a = withBuildSlot(gateFor("dep-a").gate, bounded, () => first.promise);
    await new Promise((r) => setTimeout(r, 10));
    const b = withBuildSlot(gateFor("dep-b").gate, bounded, async () => {});
    await b;
    first.resolve();
    await a;
    expect(state.recorded).toHaveLength(0);
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
