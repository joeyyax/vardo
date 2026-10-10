import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory lease table with the same rules as leader_lease, on the fake clock.
const { leases, jobs, features, holderRef } = vi.hoisted(() => ({
  leases: new Map<string, { holder: string; epoch: number; expiresAt: number }>(),
  jobs: { ticks: [] as string[], oks: [] as string[], failures: [] as string[] },
  features: { enabled: true },
  holderRef: { current: "proc-a" },
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => features.enabled }));
vi.mock("@/lib/worker/instance", () => ({ instanceId: () => holderRef.current }));
vi.mock("@/lib/worker/jobs", () => ({
  recordTick: vi.fn(async (name: string) => void jobs.ticks.push(name)),
  recordOk: vi.fn(async (name: string) => void jobs.oks.push(name)),
}));
vi.mock("@/lib/worker/tick-failure", () => ({
  logTickFailure: vi.fn(),
  recordTickFailure: vi.fn(async (_log: unknown, name: string) => void jobs.failures.push(name)),
}));
vi.mock("@/lib/worker/lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker/lease")>();
  return {
    ...actual,
    acquireLease: vi.fn(async (name: string, ttlMs: number, holder = holderRef.current) => {
      const now = Date.now();
      const row = leases.get(name);
      if (row && row.holder !== holder && row.expiresAt > now) return null;
      const epoch = !row ? 1 : row.holder === holder ? row.epoch : row.epoch + 1;
      leases.set(name, { holder, epoch, expiresAt: now + ttlMs });
      return { name, holder, epoch };
    }),
    releaseLease: vi.fn(async (lease: { name: string; holder: string; epoch: number }) => {
      const row = leases.get(lease.name);
      if (row && row.holder === lease.holder && row.epoch === lease.epoch) row.expiresAt = Date.now();
    }),
    checkFence: vi.fn(async (lease: { name: string; holder: string; epoch: number }) => {
      const row = leases.get(lease.name);
      return !!row && row.holder === lease.holder && row.epoch === lease.epoch && row.expiresAt > Date.now();
    }),
  };
});

import { IntervalLoop, type LoopContext } from "@/lib/worker/interval-loop";
import { holdsFence } from "@/lib/worker/fence";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** Runs `fn` with `holder` as this process's instance id. */
async function as<T>(holder: string, fn: () => T): Promise<Awaited<T>> {
  const previous = holderRef.current;
  holderRef.current = holder;
  try {
    return await fn();
  } finally {
    holderRef.current = previous;
  }
}

beforeEach(() => {
  leases.clear();
  jobs.ticks.length = 0;
  jobs.oks.length = 0;
  jobs.failures.length = 0;
  features.enabled = true;
  holderRef.current = "proc-a";
  delete process.env.VARDO_LEASES;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IntervalLoop", () => {
  it("stop() waits for the pass in flight instead of cutting it mid-write", async () => {
    const g = gate();
    let finished = false;
    const loop = new IntervalLoop({
      name: "t",
      intervalMs: 50,
      run: async () => {
        await g.promise;
        finished = true;
      },
    });
    void loop.tick();
    await vi.waitFor(() => expect(jobs.ticks).toEqual(["t"]));

    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    g.release();
    await stopping;
    expect(finished).toBe(true);
  });

  it("a tick arriving mid-pass joins it rather than stacking a second pass", async () => {
    const g = gate();
    let passes = 0;
    const loop = new IntervalLoop({
      name: "t",
      intervalMs: 50,
      run: async () => {
        passes += 1;
        await g.promise;
        return passes;
      },
    });
    const first = loop.tick();
    const second = loop.tick();
    g.release();
    expect(await second).toBe(await first);
    expect(passes).toBe(1);
  });

  it("a failing pass is recorded and the loop keeps its schedule", async () => {
    let attempts = 0;
    const loop = new IntervalLoop({
      name: "failing",
      intervalMs: 5,
      firstRunMs: 0,
      run: async () => {
        attempts += 1;
        throw new Error("every tick throws");
      },
    });
    loop.start();
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1), { timeout: 2_000 });
    await loop.stop();
    expect(jobs.failures.length).toBeGreaterThan(1);
  });

  it("skips the pass while its feature is off, and still beats", async () => {
    const run = vi.fn(async () => {});
    const loop = new IntervalLoop({ name: "gated", intervalMs: 1000, run });
    loop.start({ feature: "cron" });
    features.enabled = false;
    await loop.tick();
    await loop.flush();
    expect(run).not.toHaveBeenCalled();
    expect(jobs.oks).toEqual(["gated"]);
    features.enabled = true;
    await loop.tick();
    expect(run).toHaveBeenCalledOnce();
    await loop.stop();
  });

  it("reads a dynamic interval before each wait", async () => {
    vi.useFakeTimers();
    let interval = 1000;
    const run = vi.fn(async () => {
      interval = 5000;
    });
    const loop = new IntervalLoop({ name: "dyn", intervalMs: () => interval, schedule: "delay", run });
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("keeps a fixed rate and skips a slot while a pass runs", async () => {
    vi.useFakeTimers();
    const g = gate();
    const run = vi.fn(() => g.promise);
    const loop = new IntervalLoop({ name: "rate", intervalMs: 1000, run });
    loop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    g.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("overlap starts each scheduled pass even while one runs", async () => {
    vi.useFakeTimers();
    const g = gate();
    const run = vi.fn(() => g.promise);
    const loop = new IntervalLoop({ name: "overlap", intervalMs: 1000, overlap: true, run });
    loop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(3);
    g.release();
    await loop.stop();
  });
});

describe("IntervalLoop singleton", () => {
  it("runs only while holding the lease", async () => {
    leases.set("single", { holder: "proc-b", epoch: 4, expiresAt: Date.now() + 60_000 });
    const run = vi.fn(async () => {});
    const loop = new IntervalLoop({ name: "single", intervalMs: 1000, run });
    loop.start({ singleton: true });

    await loop.tick();
    expect(run).not.toHaveBeenCalled();
    expect(jobs.ticks).toEqual([]);

    leases.get("single")!.expiresAt = Date.now() - 1;
    await loop.tick();
    expect(run).toHaveBeenCalledOnce();
    expect(leases.get("single")).toMatchObject({ holder: "proc-a", epoch: 5 });
    await loop.stop();
  });

  it("hands its lease back on stop, so a standby takes it at once", async () => {
    const loop = new IntervalLoop({ name: "handback", intervalMs: 1000, run: async () => {} });
    loop.start({ singleton: true });
    await loop.tick();
    await loop.stop();

    const other = new IntervalLoop({ name: "handback", intervalMs: 1000, run: async () => {} });
    await as("proc-b", async () => {
      other.start({ singleton: true });
      await other.tick();
    });
    expect(leases.get("handback")).toMatchObject({ holder: "proc-b", epoch: 2 });
    await other.stop();
  });

  it("a standby retries the lease once per TTL, not once per interval", async () => {
    vi.useFakeTimers();
    leases.set("daily", { holder: "proc-b", epoch: 1, expiresAt: Date.now() + 60_000 });
    const run = vi.fn(async () => {});
    const loop = new IntervalLoop({ name: "daily", intervalMs: 24 * 60 * 60_000, firstRunMs: 0, run });
    loop.start({ singleton: true, leaseTtlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();

    // The holder stops; the standby takes over within a TTL.
    leases.get("daily")!.expiresAt = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();
    await loop.stop();
  });

  it("renews every TTL/3 during a long pass and stops at the next checkpoint once the lease is lost", async () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const loop = new IntervalLoop({
      name: "long",
      intervalMs: 60 * 60_000,
      run: async (ctx: LoopContext) => {
        for (let row = 0; row < 10; row++) {
          if (!ctx.active) break;
          seen.push(await holdsFence());
          await new Promise((r) => setTimeout(r, 30_000));
        }
      },
    });
    loop.start({ singleton: true, leaseTtlMs: 60_000 });
    const pass = loop.tick();
    await vi.advanceTimersByTimeAsync(90_000);
    // Renewed while the pass ran, past the original TTL.
    expect(leases.get("long")!.expiresAt).toBeGreaterThan(Date.now());
    expect(seen.every(Boolean)).toBe(true);

    // Another process steals it, as after a long stall.
    leases.set("long", { holder: "proc-b", epoch: 9, expiresAt: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    await pass;
    expect(seen.length).toBeLessThan(10);
    await loop.stop();
  });

  it("two processes sharing a lease run each pass exactly once", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const make = () => new IntervalLoop({ name: "shared", intervalMs: 1000, firstRunMs: 0, run: async () => void runs++ });
    const a = make();
    const b = make();
    a.start({ singleton: true });
    await vi.advanceTimersByTimeAsync(0);
    await as("proc-b", async () => {
      b.start({ singleton: true });
      await vi.advanceTimersByTimeAsync(0);
    });

    for (let slot = 0; slot < 5; slot++) {
      await vi.advanceTimersByTimeAsync(1000);
      await as("proc-b", () => b.tick());
    }
    // proc-a's first pass plus one per slot; proc-b never ran.
    expect(runs).toBe(6);
    expect(leases.get("shared")!.holder).toBe("proc-a");
    await a.stop();
    await b.stop();
  });

  it("holdsFence is false once another process holds the lease", async () => {
    let check: Promise<boolean> | null = null;
    const g = gate();
    const loop = new IntervalLoop({
      name: "fenced",
      intervalMs: 1000,
      run: async () => {
        await g.promise;
        check = holdsFence();
      },
    });
    loop.start({ singleton: true });
    const pass = loop.tick();
    await vi.waitFor(() => expect(leases.get("fenced")?.holder).toBe("proc-a"));
    leases.set("fenced", { holder: "proc-b", epoch: 2, expiresAt: Date.now() + 60_000 });
    g.release();
    await pass;
    expect(await check).toBe(false);
    await loop.stop();
  });

  it("VARDO_LEASES=off runs singletons without a lease", async () => {
    process.env.VARDO_LEASES = "off";
    leases.set("killed", { holder: "proc-b", epoch: 1, expiresAt: Date.now() + 60_000 });
    const run = vi.fn(async () => holdsFence());
    const loop = new IntervalLoop({ name: "killed", intervalMs: 1000, run });
    loop.start({ singleton: true });
    expect(await loop.tick()).toBe(true);
    expect(leases.get("killed")!.holder).toBe("proc-b");
    await loop.stop();
  });
});
