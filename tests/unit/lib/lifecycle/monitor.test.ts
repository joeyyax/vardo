import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = new Map<string, string>();
const files = new Map<string, string>();
const emitted: { orgId: string; event: { type: string } & Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: async () => [{ id: "org_admin" }] };
  return {
    db: {
      query: {
        systemSettings: {
          findFirst: async ({ where }: { where: (t: unknown, ops: unknown) => unknown }) => {
            let key = "";
            where({ key: "key" }, { eq: (_: unknown, value: string) => (key = value) });
            const value = settings.get(key);
            return value === undefined ? undefined : { key, value };
          },
        },
        organizations: { findMany: async () => [{ id: "org_admin" }] },
      },
      select: () => chain,
      insert: () => ({
        values: (row: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => {
            settings.set(row.key, row.value);
          },
        }),
      }),
      delete: () => ({ where: async () => settings.delete("lifecycle_shutdown") }),
    },
  };
});
vi.mock("@/lib/db/schema", () => ({ memberships: {}, systemSettings: { key: "key" }, user: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: { type: string }) => emitted.push({ orgId, event }),
}));
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => [], listAllContainers: async () => [] }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {}, shutdownSignal: () => "SIGTERM" }));
const compare = vi.hoisted(() => ({ fetch: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/lib/version", () => ({
  getBuildSha: () => "4f1a9b2c",
  fetchCompare: compare.fetch,
  moreCommits: (total: number, listed: number) => (listed > 0 && total > listed ? { moreCommits: total - listed } : {}),
}));
vi.mock("fs/promises", () => ({
  readFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  },
}));

const { checkUpdateMarker, startLifecycleMonitor, UPDATE_MARKER_FILE, UPDATE_POLL_MS, UPDATE_WAIT_MS } = await import("@/lib/lifecycle/monitor");

const nowS = () => Math.floor(Date.now() / 1000);

function writeMarker(marker: Record<string, unknown>) {
  files.set(UPDATE_MARKER_FILE, JSON.stringify(marker));
}

beforeEach(() => {
  settings.clear();
  files.clear();
  emitted.length = 0;
  delete (globalThis as { __vardo_lifecycle?: boolean }).__vardo_lifecycle;
});

describe("update event flow", () => {
  it("announces a slow update from the console that was running, once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Started after this process: the running console is the old one.
      writeMarker({ id: "run-1", state: "started", startedAt: nowS() + 5, fromVersion: "e36c2e3", branch: "main", fromSlot: "blue", toSlot: "green" });
      expect(await checkUpdateMarker()).toBeNull();
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await checkUpdateMarker()).toBe("started");
      expect(await checkUpdateMarker()).toBeNull();
      expect(emitted.map((e) => e.event.type)).toEqual(["system.update-started"]);
      expect(emitted[0]).toMatchObject({ orgId: "org_admin", event: { fromVersion: "e36c2e3", toSlot: "green" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when an update lands on the commit it started from", async () => {
    writeMarker({
      id: "run-same",
      state: "updated",
      startedAt: nowS() - 40,
      finishedAt: nowS(),
      fromVersion: "0.1.0 (0928e9c)",
      toVersion: "0.1.0 (0928e9c)",
    });
    expect(await checkUpdateMarker()).toBeNull();
    expect(emitted).toEqual([]);
    expect(await checkUpdateMarker()).toBeNull();
  });

  it("adds the update's commits from GitHub", async () => {
    compare.fetch.mockResolvedValueOnce({
      status: "ahead",
      aheadBy: 3,
      commits: [{ sha: "559e5b2", subject: "fix: quieter emails" }],
      url: "https://github.com/example/vardo/compare/bc2083d...559e5b2",
    });
    writeMarker({ id: "run-c", state: "updated", startedAt: nowS() - 60, finishedAt: nowS(), fromVersion: "0.1.0 (bc2083d)", toVersion: "0.1.0 (559e5b2)" });
    expect(await checkUpdateMarker()).toBe("updated");
    expect(compare.fetch).toHaveBeenCalledWith("bc2083d", "559e5b2");
    expect(emitted[0].event).toMatchObject({
      commits: [{ sha: "559e5b2", subject: "fix: quieter emails" }],
      moreCommits: 2,
      changesUrl: "https://github.com/example/vardo/compare/bc2083d...559e5b2",
    });
  });

  it("announces a failure with the step and log tail", async () => {
    writeMarker({
      id: "run-2",
      state: "failed",
      startedAt: nowS() - 300,
      finishedAt: nowS() - 1,
      fromVersion: "e36c2e3",
      toVersion: "4f1a9b2",
      step: "Building green slot",
      error: "docker compose build exited 1",
      logTail: ["#9 ERROR: failed to solve"],
    });
    expect(await checkUpdateMarker()).toBe("failed");
    expect(emitted[0].event).toMatchObject({
      type: "system.update-failed",
      step: "Building green slot",
      durationSeconds: 299,
      logTail: ["#9 ERROR: failed to solve"],
    });
  });

  it("boots after an update with one updated message, not a started one", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 60_000, hostBootAt: null, version: "x" }));
    settings.set("lifecycle_shutdown", JSON.stringify({ at: Date.now() - 20_000, reason: "vardo update", version: "x" }));
    writeMarker({
      id: "run-3",
      state: "updated",
      startedAt: nowS() - 212,
      finishedAt: nowS(),
      swapStartedAt: nowS() - 18,
      healthyAt: nowS(),
      fromVersion: "e36c2e3",
      toVersion: "4f1a9b2",
      fromSlot: "blue",
      toSlot: "green",
    });
    await startLifecycleMonitor();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.updated"]);
    expect(emitted[0].event).toMatchObject({ fromVersion: "e36c2e3", toVersion: "4f1a9b2", durationSeconds: 212, downSeconds: 18 });
    expect(settings.has("lifecycle_shutdown")).toBe(false);
    expect(settings.has("lifecycle_heartbeat")).toBe(true);
  });

  it("boots after a clean stop with one started message", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 60_000, hostBootAt: null, version: "x" }));
    settings.set("lifecycle_shutdown", JSON.stringify({ at: Date.now() - 20_000, reason: "Stop signal", version: "x" }));
    await startLifecycleMonitor();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.started"]);
  });

  it("boots without a shutdown marker as an unclean recovery", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 60_000, hostBootAt: null, version: "x" }));
    await startLifecycleMonitor();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.recovered-unclean"]);
  });
});

describe("booting into an update", () => {
  // bc2083d → 559e5b2: the new console booted with the marker "started"; install.sh wrote "updated" 2s later.
  const id = "20261010004345-434368";
  const started = (startedAt: number) => ({ id, state: "started", startedAt, fromVersion: "bc2083d", toVersion: "559e5b2", fromSlot: "green", toSlot: "blue" });

  function bootIntoUpdate() {
    const startedAt = nowS() - 170;
    // The old console stopped without its marker, so this boot classifies unclean.
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 25_000, hostBootAt: null, version: "x" }));
    settings.set("lifecycle_update_seen", JSON.stringify({ id, states: ["started"] }));
    writeMarker(started(startedAt));
    return startedAt;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the boot message until the update reports, then sends only system.updated", async () => {
    const startedAt = bootIntoUpdate();
    await startLifecycleMonitor();
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    writeMarker({ ...started(startedAt), state: "updated", finishedAt: nowS(), swapStartedAt: nowS() - 20, healthyAt: nowS() });
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(emitted.map((e) => e.event.type)).toEqual(["system.updated"]);
    expect(emitted[0].event).toMatchObject({ fromVersion: "bc2083d", toVersion: "559e5b2", downSeconds: 20 });

    // Heartbeat ticks and the rest of the wait add nothing.
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_MS);
    expect(emitted.map((e) => e.event.type)).toEqual(["system.updated"]);
  });

  it("sends a failure when the update reports one", async () => {
    const startedAt = bootIntoUpdate();
    await startLifecycleMonitor();
    writeMarker({ ...started(startedAt), state: "failed", finishedAt: nowS(), step: "Health check", rolledBack: true });
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(emitted.map((e) => e.event.type)).toEqual(["system.update-failed"]);
    expect(emitted[0].event).toMatchObject({ step: "Health check", rolledBack: true });
  });

  it("reports an update that never finishes, once", async () => {
    bootIntoUpdate();
    await startLifecycleMonitor();
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_MS - UPDATE_POLL_MS);
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * UPDATE_POLL_MS);
    expect(emitted.map((e) => e.event.type)).toEqual(["system.update-failed"]);
    expect(String(emitted[0].event.error)).toContain("didn't report");

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_MS);
    expect(emitted).toHaveLength(1);
  });

  it("sends system.updated alone when the marker finished before the console looked", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 25_000, hostBootAt: null, version: "x" }));
    settings.set("lifecycle_update_seen", JSON.stringify({ id, states: ["started"] }));
    writeMarker({ ...started(nowS() - 170), state: "updated", finishedAt: nowS() });
    await startLifecycleMonitor();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.updated"]);
  });
});
