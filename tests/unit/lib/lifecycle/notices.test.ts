import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WatchdogEvent } from "@/lib/system-alerts/watchdog-events";

const settings = new Map<string, string>();
const files = new Map<string, string>();
const claims = new Set<string>();
const openIncidents = new Set<string>();
const emitted: { orgId: string; event: { type: string; incident?: { id: string; transition: string } } & Record<string, unknown> }[] = [];
const containers: { state: string; status: string; labels: Record<string, string> }[] = [];
const io = vi.hoisted(() => ({ stall: null as Promise<void> | null, failStream: false }));

vi.mock("@/lib/db", () => ({
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
    },
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          settings.set(row.key, row.value);
        },
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({ systemSettings: { key: "key" } }));
vi.mock("@/lib/notifications/dispatch", () => ({
  emitConfirmed: async (orgId: string, event: { type: string }) => {
    if (io.stall) await io.stall;
    if (io.failStream) throw new Error("stream down");
    emitted.push({ orgId, event });
  },
}));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: async () => ["org_admin"] }));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: async (key: string) => {
    if (claims.has(key)) return null;
    claims.add(key);
    return key;
  },
  releaseLock: async (key: string) => claims.delete(key),
}));
vi.mock("@/lib/incidents/store", () => ({
  safely: async <T,>(_what: string, fn: () => Promise<T>, fallback: T) => fn().catch(() => fallback),
  openIncident: async (_org: string, req: { about: string }) => {
    openIncidents.add(req.about);
    return { id: `inc_${req.about}`, transition: "opened" };
  },
  resolveIncidents: async (_org: string, _kind: string, abouts: string[]) =>
    new Map(abouts.filter((a) => openIncidents.delete(a)).map((a) => [a, { id: `inc_${a}`, transition: "resolved" }])),
}));
vi.mock("@/lib/docker/client", () => ({ listContainers: async () => containers }));
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

const notices = await import("@/lib/lifecycle/notices");
const { WATCHDOG_EVENTS_FILE } = await import("@/lib/system-alerts/watchdog-events");
const { activeRestart, consoleBooted, consoleStopping, flushOutbox, planStop, reconcileRestarts, restartStarted, watchdogEvent } = notices;

const T0 = Date.parse("2026-10-10T12:00:00Z");
const types = () => emitted.map((e) => e.event.type);
const outbox = () => [...files.keys()].filter((p) => p.startsWith(notices.OUTBOX_DIR));
const clean = (downSeconds = 60) => ({ kind: "clean" as const, downSeconds, hostRebooted: false, reason: "vardo stop" });

beforeEach(() => {
  settings.clear();
  files.clear();
  claims.clear();
  openIncidents.clear();
  emitted.length = 0;
  containers.length = 0;
  io.stall = null;
  io.failStream = false;
});

describe("stop and start", () => {
  it("sends stopping, then back up on the next boot in the same incident", async () => {
    files.set(notices.STOP_REASON_FILE, JSON.stringify({ reason: "vardo stop", at: Math.floor(T0 / 1000) }));
    const plan = await planStop(null, T0);
    expect(plan).toMatchObject({ kind: "stop", reason: "vardo stop" });
    await consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 600, now: T0 });

    await consoleBooted({
      boot: { kind: "clean", downSeconds: 75, hostRebooted: true, reason: plan.reason },
      shutdown: { at: T0, reason: plan.reason, version: "0.1.0", id: plan.id, kind: "stop" },
      heartbeat: null,
      version: "0.1.0",
      quiet: false,
      now: T0 + 75_000,
    });

    expect(types()).toEqual(["system.shutdown", "system.started"]);
    expect(emitted[0].event).toMatchObject({ title: "Vardo is stopping", reason: "vardo stop", incident: { id: `inc_${plan.id}`, transition: "opened" } });
    expect(emitted[1].event).toMatchObject({ title: "Vardo is back up", downSeconds: 75, hostRebooted: true, incident: { id: `inc_${plan.id}`, transition: "resolved" } });
    expect(outbox()).toEqual([]);
  });

  it("falls back to the signal when no reason was left", async () => {
    expect((await planStop(null, T0)).reason).toBe(notices.DEFAULT_STOP_REASON);
    files.set(notices.STOP_REASON_FILE, JSON.stringify({ reason: "vardo stop", at: Math.floor(T0 / 1000) - 600 }));
    expect((await planStop("Interrupted (SIGINT)", T0)).reason).toBe("Interrupted (SIGINT)");
  });

  it("keeps a stopping notice that missed the budget and sends it first on the next boot", async () => {
    vi.useFakeTimers();
    try {
      let release = () => {};
      io.stall = new Promise<void>((resolve) => (release = resolve));
      const plan = await planStop(null, T0);
      const stopping = consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 600, now: T0 });
      await vi.advanceTimersByTimeAsync(notices.SHUTDOWN_SEND_BUDGET_MS);
      await stopping;
      expect(emitted).toEqual([]);
      expect(outbox()).toHaveLength(1);
      release();
      await flushOutbox();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends what the outbox kept, in order, before back up", async () => {
    io.failStream = true;
    const plan = await planStop(null, T0);
    await consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 600, now: T0 });
    expect(outbox()).toHaveLength(1);

    io.failStream = false;
    await consoleBooted({
      boot: clean(),
      shutdown: { at: T0, reason: plan.reason, version: "0.1.0", id: plan.id, kind: "stop" },
      heartbeat: null,
      version: "0.1.0",
      quiet: false,
      now: T0 + 60_000,
    });
    expect(types()).toEqual(["system.shutdown", "system.started"]);
    expect(outbox()).toEqual([]);
  });

  it("sends stopped unexpectedly, then back up, after an unclean stop", async () => {
    await consoleBooted({
      boot: { kind: "unclean", downSeconds: 300, hostRebooted: false, lastHeartbeatAt: new Date(T0).toISOString() },
      shutdown: null,
      heartbeat: { at: T0, hostBootAt: null, version: "0.1.0" },
      version: "0.1.0",
      quiet: false,
      now: T0 + 300_000,
    });
    expect(types()).toEqual(["system.recovered-unclean", "system.started"]);
    expect(emitted[0].event).toMatchObject({ title: "Vardo stopped unexpectedly", lastHeartbeatAt: new Date(T0).toISOString(), incident: { transition: "opened" } });
    expect(emitted[1].event).toMatchObject({ incident: { transition: "resolved" } });
  });

  it("sends nothing for a boot an update or handover explains, but still empties the outbox", async () => {
    io.failStream = true;
    await consoleStopping(await planStop(null, T0), { version: "0.1.0", uptimeSeconds: 1, now: T0 });
    io.failStream = false;
    await consoleBooted({ boot: clean(), shutdown: null, heartbeat: null, version: "0.1.0", quiet: true, now: T0 + 1_000 });
    expect(types()).toEqual(["system.shutdown"]);
  });

  it("never sends a notice twice across consoles", async () => {
    const plan = await planStop(null, T0);
    await consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 1, now: T0 });
    // A second console flushing a copy of the same notice.
    files.set(`${notices.OUTBOX_DIR}/00000000000001-copy.json`, JSON.stringify({ key: `${plan.id}:stopping`, at: 1, event: { type: "system.shutdown" } }));
    await flushOutbox();
    expect(types()).toEqual(["system.shutdown"]);
  });
});

describe("restarts from the app", () => {
  it("pairs a services restart with restarted once every service is back", async () => {
    const id = await restartStarted({ target: "services", label: "Vardo's shared services", source: "maintenance", services: ["postgres", "redis"] }, { now: T0 });
    expect(types()).toEqual(["system.restarting"]);
    expect(await activeRestart(T0 + 1_000)).toMatchObject({ id, label: "Vardo's shared services" });

    containers.push(
      { state: "running", status: "Up 5 seconds (health: starting)", labels: { "com.docker.compose.project": "vardo", "com.docker.compose.service": "postgres" } },
      { state: "running", status: "Up 6 seconds (healthy)", labels: { "com.docker.compose.project": "vardo", "com.docker.compose.service": "redis" } },
    );
    await reconcileRestarts(T0 + notices.RESTART_SETTLE_MS);
    expect(types()).toEqual(["system.restarting"]);

    containers[0].status = "Up 20 seconds (healthy)";
    await reconcileRestarts(T0 + 40_000);
    expect(types()).toEqual(["system.restarting", "system.restarted"]);
    expect(emitted[1].event).toMatchObject({ title: "Vardo's shared services restarted", durationSeconds: 40, incident: { transition: "resolved" } });
    expect(await activeRestart(T0 + 41_000)).toBeNull();
  });

  it("says what didn't come back at the deadline", async () => {
    await restartStarted({ target: "services", label: "vardo-postgres", source: "maintenance", services: ["postgres"] }, { now: T0 });
    await reconcileRestarts(T0 + notices.RESTART_DEADLINE_MS);
    expect(types()).toEqual(["system.restarting", "system.restart-failed"]);
    expect(String(emitted[1].event.error)).toContain("postgres isn't back");
  });

  it("closes a console restart on the next boot", async () => {
    const id = await restartStarted({ target: "console", label: "Vardo", source: "console" }, { now: T0 });
    const plan = await planStop(null, T0 + 2_000);
    expect(plan).toEqual({ id, kind: "restart", reason: "Restart: Vardo" });
    await consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 1, now: T0 + 2_000 });
    await consoleBooted({
      boot: clean(10),
      shutdown: { at: T0 + 2_000, reason: plan.reason, version: "0.1.0", id, kind: "restart" },
      heartbeat: null,
      version: "0.1.0",
      quiet: false,
      now: T0 + 12_000,
    });
    expect(types()).toEqual(["system.restarting", "system.restarted"]);
  });
});

describe("watchdog restarts", () => {
  const event = (action: WatchdogEvent["action"], tsOffset: number, role = "worker"): WatchdogEvent => ({ ts: Math.floor(T0 / 1000) + tsOffset, role, container: `vardo-${role}`, action, fails: 3 });

  it("pairs restarting and restart for the worker", async () => {
    await watchdogEvent({ ...event("restarting", 0) }, T0);
    await watchdogEvent({ ...event("restart", 20) }, T0 + 20_000);
    expect(types()).toEqual(["system.restarting", "system.restarted"]);
    expect(emitted[0].event).toMatchObject({ source: "watchdog", target: "worker", label: "the Vardo worker" });
  });

  it("sends didn't come back when the watchdog's restart failed", async () => {
    await watchdogEvent({ ...event("restarting", 0) }, T0);
    await watchdogEvent({ ...event("restart-failed", 5) }, T0 + 5_000);
    expect(types()).toEqual(["system.restarting", "system.restart-failed"]);
  });

  it("sends the whole pair for a restart it didn't see start", async () => {
    await watchdogEvent({ ...event("restart", 20) }, T0 + 20_000);
    expect(types()).toEqual(["system.restarting", "system.restarted"]);
  });

  it("leaves other containers and backoffs to the alerts", async () => {
    expect(await watchdogEvent({ ...event("restart", 0, "traefik") }, T0)).toBe(false);
    expect(await watchdogEvent({ ...event("backoff", 0) }, T0)).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("covers a console the watchdog restarted with one pair, whichever path sees it first", async () => {
    files.set(WATCHDOG_EVENTS_FILE, `${JSON.stringify(event("restarting", 0, "console"))}\n`);
    // The hung console never ran its shutdown, so the boot is unclean.
    await consoleBooted({
      boot: { kind: "unclean", downSeconds: 40, hostRebooted: false, lastHeartbeatAt: new Date(T0 - 60_000).toISOString() },
      shutdown: null,
      heartbeat: { at: T0 - 60_000, hostBootAt: null, version: "0.1.0" },
      version: "0.1.0",
      quiet: false,
      now: T0 + 40_000,
    });
    await watchdogEvent({ ...event("restarting", 0, "console") }, T0 + 41_000);
    await watchdogEvent({ ...event("restart", 35, "console") }, T0 + 42_000);
    expect(types()).toEqual(["system.restarting", "system.restarted"]);
  });

  it("treats a console stopping right after the watchdog's restarting as that restart", async () => {
    files.set(WATCHDOG_EVENTS_FILE, `${JSON.stringify(event("restarting", 0, "console"))}\n`);
    const plan = await planStop(null, T0 + 1_000);
    expect(plan).toMatchObject({ kind: "restart", id: `watchdog-console-${Math.floor(T0 / 1000)}` });
    await consoleStopping(plan, { version: "0.1.0", uptimeSeconds: 1, now: T0 + 1_000 });
    expect(types()).toEqual(["system.restarting"]);
  });
});
