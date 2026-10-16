import { beforeEach, describe, expect, it, vi } from "vitest";

const TARGET = "b".repeat(40);
const TICK_MS = 60_000;
const GRACE_MS = 3 * 60_000;

const h = vi.hoisted(() => ({ unhealthy: [] as string[] }));

const rows = () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.then = (resolve: (v: unknown[]) => void) => resolve([]);
  return chain;
};

vi.mock("@/lib/db", () => ({ db: { select: rows, query: { apps: { findFirst: async () => null } } } }));
vi.mock("@/lib/docker/disk-guard", () => ({ readDiskSpace: async () => ({ freeBytes: 50 * 1024 ** 3, usedBytes: 50 * 1024 ** 3 }) }));
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => [] }));
vi.mock("@/lib/config/health", () => ({
  getSystemHealth: async () => ({ services: h.unhealthy.map((name) => ({ name, status: "unhealthy" })) }),
}));
vi.mock("@/lib/redis-lock", () => ({ acquireLock: async () => true, releaseLock: async () => {} }));
vi.mock("@/lib/worker/interval-loop", () => ({ IntervalLoop: class {} }));
vi.mock("@/lib/lifecycle/self-deploy", () => ({ formatVersion: () => "" }));
vi.mock("@/lib/self-update/lifecycle", () => ({ updateFailed: async () => true }));
vi.mock("@/lib/self-update/peer-status", () => ({ setLocalVardoStatus: () => {} }));
vi.mock("@/lib/version", () => ({ getBuildSha: () => "a".repeat(40), fetchCompare: async () => ({ status: "ahead" }) }));
vi.mock("@/lib/paths", () => ({ isSelfDeployLayout: () => true }));
vi.mock("@/lib/self-update/store", () => ({
  getUpdatePolicy: async () => ({ mode: "auto", priority: "standard", channel: "main" }),
  getUpdateRun: async () => null,
  getUpdateState: async () => ({ failedTargets: [], versionSince: null }),
  setUpdateRun: async () => {},
  updateState: async () => ({}),
}));

const { readPeerReadiness } = await import("@/lib/self-update/rollout-peer");

const probe = () => readPeerReadiness(TARGET, "main", "r1");

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  h.unhealthy = [];
  await probe();
});

describe("health gate across ticks", () => {
  it("proceeds after one transient unhealthy probe", async () => {
    h.unhealthy = ["Redis", "Loki"];
    expect((await probe()).state).toBe("busy");

    vi.advanceTimersByTime(TICK_MS);
    h.unhealthy = [];
    expect((await probe()).state).toBe("ready");
  });

  it("restarts the clock after a clean probe", async () => {
    h.unhealthy = ["Redis"];
    await probe();
    vi.advanceTimersByTime(GRACE_MS - 1000);
    h.unhealthy = [];
    await probe();
    h.unhealthy = ["Redis"];
    vi.advanceTimersByTime(2000);
    expect((await probe()).state).toBe("busy");
  });

  it("blocks once it stays unhealthy for three minutes", async () => {
    h.unhealthy = ["Redis"];
    for (let i = 0; i < GRACE_MS / TICK_MS; i++) {
      expect((await probe()).state).toBe("busy");
      vi.advanceTimersByTime(TICK_MS);
    }
    expect(await probe()).toMatchObject({ state: "blocked", reason: "Unhealthy: Redis" });
  });
});
