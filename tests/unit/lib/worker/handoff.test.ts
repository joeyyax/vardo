import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntervalLoop } from "@/lib/worker/interval-loop";
import type { LoopEntry } from "@/lib/worker/registry";

// Web hands its instance-wide loops to a present worker and takes them back two minutes after it goes.

const { rows, loops, collector } = vi.hoisted(() => ({
  rows: { value: [] as { heartbeatAt: Date; readyAt: Date | null; drainingAt: Date | null }[] },
  loops: new Map<string, { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>(),
  collector: { running: false, stop: vi.fn(async () => {}) },
}));

function fakeEntry(name: string, roles: LoopEntry["roles"], extra: Partial<LoopEntry> = {}): LoopEntry {
  const spies = { start: vi.fn(), stop: vi.fn(async () => {}) };
  loops.set(name, spies);
  return { name, roles, singleton: true, load: async () => ({ name, ...spies }) as unknown as IntervalLoop, ...extra };
}

vi.mock("@/lib/worker/registry", () => ({
  LOOP_REGISTRY: [
    fakeEntry("backup-tick", ["web", "worker"]),
    fakeEntry("config-sync", ["web", "worker"], { singleton: false, perProcess: true }),
    fakeEntry("deploy-request", ["web"], { singleton: false }),
  ],
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => true }));
vi.mock("@/lib/metrics/collector", () => ({ isCollectorRunning: () => collector.running, stopCollector: collector.stop }));
vi.mock("@/lib/worker/presence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worker/presence")>()),
  readWorkers: async () => ({ now: new Date(), rows: rows.value }),
}));

const T0 = new Date("2026-10-10T12:00:00Z").getTime();
const presentWorker = () => [{ heartbeatAt: new Date(), readyAt: new Date(), drainingAt: null }];
const running = (name: string) => loops.get(name)!.start.mock.calls.length - loops.get(name)!.stop.mock.calls.length;

let handoff: typeof import("@/lib/worker/handoff");

beforeEach(async () => {
  vi.resetModules();
  const g = globalThis as Record<string, unknown>;
  delete g.__vardo_handoff;
  delete g.__vardo_started_loops;
  for (const spies of loops.values()) {
    spies.start.mockClear();
    spies.stop.mockClear();
  }
  rows.value = [];
  collector.running = false;
  vi.stubEnv("VARDO_LOOPS_IN_WEB", "auto");
  handoff = await import("@/lib/worker/handoff");
});

afterEach(() => vi.unstubAllEnvs());

describe("decideHandoff", () => {
  const state = (deferred: boolean, lastPresentAt: number | null = null) => ({ deferred, lastPresentAt });

  it("defers once a worker is present and stays deferred while it is", () => {
    expect(handoff.decideHandoff(state(false), "auto", true, T0)).toBe("defer");
    expect(handoff.decideHandoff(state(true, T0), "auto", true, T0)).toBe("stay");
  });

  it("takes loops back only after two minutes without a present worker", () => {
    expect(handoff.decideHandoff(state(true, T0), "auto", false, T0 + 119_000)).toBe("stay");
    expect(handoff.decideHandoff(state(true, T0), "auto", false, T0 + 120_000)).toBe("resume");
  });

  it("follows always and never regardless of the worker", () => {
    expect(handoff.decideHandoff(state(true, T0), "always", true, T0)).toBe("resume");
    expect(handoff.decideHandoff(state(false), "always", true, T0)).toBe("stay");
    expect(handoff.decideHandoff(state(false), "never", false, T0)).toBe("defer");
    expect(handoff.decideHandoff(state(true), "never", false, T0 + 10 * 60_000)).toBe("stay");
  });
});

describe("web loops with a worker coming and going", () => {
  it("starts everything without a worker, hands instance-wide loops over, and takes them back", async () => {
    await handoff.startWebLoops();
    expect(running("backup-tick")).toBe(1);
    expect(running("config-sync")).toBe(1);
    expect(running("deploy-request")).toBe(1);

    rows.value = presentWorker();
    expect(await handoff.handoffPass(T0)).toBe("defer");
    expect(handoff.loopsDeferredToWorker()).toBe(true);
    expect(running("backup-tick")).toBe(0);
    // Per-process and web-only loops stay.
    expect(running("config-sync")).toBe(1);
    expect(running("deploy-request")).toBe(1);

    rows.value = [];
    expect(await handoff.handoffPass(T0 + 30_000)).toBe("stay");
    expect(await handoff.handoffPass(T0 + 90_000)).toBe("stay");
    expect(running("backup-tick")).toBe(0);
    expect(await handoff.handoffPass(T0 + 120_000)).toBe("resume");
    expect(handoff.loopsDeferredToWorker()).toBe(false);
    expect(running("backup-tick")).toBe(1);
  });

  it("starts deferred when a worker is already present", async () => {
    rows.value = presentWorker();
    await handoff.startWebLoops();
    expect(handoff.loopsDeferredToWorker()).toBe(true);
    expect(running("backup-tick")).toBe(0);
    expect(running("config-sync")).toBe(1);
  });

  it("stops a collector a stats stream started outside the registry", async () => {
    await handoff.startWebLoops();
    collector.running = true;
    rows.value = presentWorker();
    await handoff.handoffPass(T0);
    expect(collector.stop).toHaveBeenCalledOnce();
  });

  it("never runs instance-wide loops in web under VARDO_LOOPS_IN_WEB=never", async () => {
    vi.stubEnv("VARDO_LOOPS_IN_WEB", "never");
    await handoff.startWebLoops();
    expect(running("backup-tick")).toBe(0);
    expect(await handoff.handoffPass(T0 + 10 * 60_000)).toBe("stay");
    expect(running("backup-tick")).toBe(0);
  });

  it("starts no loops under pnpm dev unless VARDO_DEV_WORKERS=1", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await handoff.startWebLoops();
    expect(running("backup-tick")).toBe(0);
    expect(running("config-sync")).toBe(0);
    expect(running("deploy-request")).toBe(0);

    vi.stubEnv("VARDO_DEV_WORKERS", "1");
    await handoff.startWebLoops();
    expect(running("backup-tick")).toBe(1);
    expect(running("deploy-request")).toBe(1);
  });

  it("keeps loops in web under VARDO_LOOPS_IN_WEB=always even with a worker", async () => {
    vi.stubEnv("VARDO_LOOPS_IN_WEB", "always");
    rows.value = presentWorker();
    await handoff.startWebLoops();
    expect(await handoff.handoffPass(T0)).toBe("stay");
    expect(running("backup-tick")).toBe(1);
  });
});
