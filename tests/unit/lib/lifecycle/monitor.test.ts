import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/version", () => ({ getBuildSha: () => "4f1a9b2c" }));
vi.mock("fs/promises", () => ({
  readFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  },
}));

const { checkUpdateMarker, startLifecycleMonitor, UPDATE_MARKER_FILE } = await import("@/lib/lifecycle/monitor");

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
  it("announces a started update from the console that was running, once", async () => {
    // Started after this process: the running console is the old one.
    writeMarker({ id: "run-1", state: "started", startedAt: nowS() + 5, fromVersion: "e36c2e3", branch: "main", fromSlot: "blue", toSlot: "green" });
    expect(await checkUpdateMarker()).toBe("started");
    expect(await checkUpdateMarker()).toBeNull();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.update-started"]);
    expect(emitted[0]).toMatchObject({ orgId: "org_admin", event: { fromVersion: "e36c2e3", toSlot: "green" } });
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
