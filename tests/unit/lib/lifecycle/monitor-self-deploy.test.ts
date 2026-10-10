import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = new Map<string, string>();
const files = new Map<string, string>();
const emitted: { orgId: string; event: { type: string } & Record<string, unknown> }[] = [];
const running: { id: string; name: string; labels: Record<string, string> }[] = [];
const shutdownClosers: (() => Promise<unknown> | unknown)[] = [];

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
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => running, listAllContainers: async () => [] }));
vi.mock("@/lib/shutdown", () => ({
  closeOnShutdown: (closer: () => unknown) => {
    shutdownClosers.push(closer);
    return () => {};
  },
  shutdownSignal: () => "SIGTERM",
}));
vi.mock("@/lib/version", () => ({ getBuildSha: () => "4f1a9b2c" }));
vi.mock("fs/promises", () => ({
  readFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  },
}));

const { checkUpdateMarker, startLifecycleMonitor, UPDATE_MARKER_FILE, UPDATE_POLL_MS } = await import("@/lib/lifecycle/monitor");

const OLD = "a1b2c3d4e5f6";
const NEW = "f6e5d4c3b2a1";

function writeMarker(marker: Record<string, unknown>) {
  files.set(UPDATE_MARKER_FILE, JSON.stringify(marker));
}

const selfDeploy = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "dep_123",
  kind: "self-deploy",
  state,
  startedAt: Date.now() - 200_000,
  fromVersion: "0.1.0 (e36c2e3)",
  toVersion: "0.1.0 (4f1a9b2)",
  fromSlot: "blue",
  toSlot: "green",
  fromHost: OLD,
  ...extra,
});

beforeEach(() => {
  settings.clear();
  files.clear();
  emitted.length = 0;
  running.length = 0;
  shutdownClosers.length = 0;
  delete (globalThis as { __vardo_lifecycle?: boolean }).__vardo_lifecycle;
});

afterEach(() => {
  delete process.env.CONTAINER_ID;
});

describe("the console running a self-deploy", () => {
  beforeEach(() => {
    process.env.CONTAINER_ID = OLD;
  });

  it("announces the start", async () => {
    writeMarker(selfDeploy("started", { startedAt: Date.now() + 5_000 }));
    expect(await checkUpdateMarker()).toBe("started");
    expect(emitted.map((e) => e.event.type)).toEqual(["system.update-started"]);
  });

  it("leaves the updated message to the new console", async () => {
    writeMarker(selfDeploy("updated", { finishedAt: Date.now() }));
    expect(await checkUpdateMarker()).toBeNull();
    expect(emitted).toEqual([]);
    expect(settings.has("lifecycle_update_seen")).toBe(false);
  });

  it("announces a failure, since it keeps serving", async () => {
    writeMarker(selfDeploy("failed", { finishedAt: Date.now(), step: "healthcheck", rolledBack: true }));
    expect(await checkUpdateMarker()).toBe("failed");
    expect(emitted[0].event).toMatchObject({ type: "system.update-failed", rolledBack: true });
  });

  it("stops at the end of the deploy without a shutdown marker or email", async () => {
    await startLifecycleMonitor();
    emitted.length = 0;
    writeMarker(selfDeploy("updated", { finishedAt: Date.now() }));
    for (const close of shutdownClosers) await close();
    expect(emitted).toEqual([]);
    expect(settings.has("lifecycle_shutdown")).toBe(false);
  });
});

describe("the console a self-deploy starts", () => {
  beforeEach(() => {
    process.env.CONTAINER_ID = NEW;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits through the deploy and sends one updated message", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 10_000, hostBootAt: null, version: "x", host: OLD }));
    writeMarker(selfDeploy("started"));
    await startLifecycleMonitor();
    expect(emitted).toEqual([]);

    writeMarker(selfDeploy("updated", { finishedAt: Date.now(), healthyAt: Date.now() - 5_000, swapStartedAt: Date.now() - 5_000 }));
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    expect(emitted.map((e) => e.event.type)).toEqual(["system.updated"]);
    expect(emitted[0].event).toMatchObject({ fromSlot: "blue", toSlot: "green", downSeconds: 0 });
  });

  it("reports no unclean stop when it took over from a console still running", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 10_000, hostBootAt: null, version: "x" }));
    running.push({
      id: `${OLD}9999`,
      name: "vardo-production-blue-frontend-1",
      labels: { "com.docker.compose.project": "vardo-production-blue", "com.docker.compose.service": "frontend" },
    });
    await startLifecycleMonitor();
    expect(emitted).toEqual([]);
  });

  it("still reports an unclean stop when no other console is running", async () => {
    settings.set("lifecycle_heartbeat", JSON.stringify({ at: Date.now() - 10_000, hostBootAt: null, version: "x", host: NEW }));
    await startLifecycleMonitor();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.recovered-unclean"]);
  });
});
