import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = new Map<string, string>();
const files = new Map<string, string>();
const claims = new Set<string>();
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
  emitConfirmed: async (orgId: string, event: { type: string }) => void emitted.push({ orgId, event }),
}));
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => running, listAllContainers: async () => [] }));
vi.mock("@/lib/shutdown", () => ({
  closeOnShutdown: (closer: () => unknown) => {
    shutdownClosers.push(closer);
    return () => {};
  },
  shutdownSignal: () => "SIGTERM",
}));
const compare = vi.hoisted(() => ({ fetch: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/lib/version", () => ({
  getBuildSha: () => "4f1a9b2c",
  fetchCompare: compare.fetch,
  moreCommits: (total: number, listed: number) => (listed > 0 && total > listed ? { moreCommits: total - listed } : {}),
}));
vi.mock("fs/promises", () => {
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    mkdir: async () => {},
    writeFile: async (path: string, text: string) => void files.set(path, text),
    rename: async (from: string, to: string) => {
      const text = files.get(from);
      if (text === undefined) throw missing();
      files.delete(from);
      files.set(to, text);
    },
    rm: async (path: string) => void files.delete(path),
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw missing();
      return text;
    },
    readdir: async (dir: string) => {
      const names = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
      if (names.length === 0) throw missing();
      return names;
    },
  };
});

vi.mock("@/lib/redis-lock", () => ({
  acquireLock: async (key: string) => {
    if (claims.has(key)) return null;
    claims.add(key);
    return "token";
  },
  releaseLock: async (key: string) => claims.delete(key),
}));
vi.mock("@/lib/incidents/store", () => ({
  safely: async <T,>(_what: string, fn: () => Promise<T>, fallback: T) => fn().catch(() => fallback),
  openIncident: async (_org: string, req: { about: string }) => ({ id: `inc_${req.about}`, transition: "opened" }),
  resolveIncidents: async (_org: string, _kind: string, abouts: string[]) =>
    new Map(abouts.map((about) => [about, { id: `inc_${about}`, transition: "resolved" }])),
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
  claims.clear();
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

  it("announces the start at once", async () => {
    writeMarker(selfDeploy("started", { startedAt: Date.now() + 5_000 }));
    expect(await checkUpdateMarker()).toBe("started");
    expect(await checkUpdateMarker()).toBeNull();
    expect(emitted.map((e) => e.event.type)).toEqual(["system.update-started"]);
    expect(emitted[0].event).toMatchObject({ toVersion: "0.1.0 (4f1a9b2)", incident: { id: "inc_dep_123" } });
  });

  it("leaves the updated message to the new console", async () => {
    writeMarker(selfDeploy("updated", { finishedAt: Date.now() }));
    expect(await checkUpdateMarker()).toBeNull();
    expect(emitted).toEqual([]);
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
    // The old console announced the start.
    claims.add("self-update:notice:dep_123:started");
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
    expect(emitted.map((e) => e.event.type)).toEqual(["system.recovered-unclean", "system.started"]);
  });
});
