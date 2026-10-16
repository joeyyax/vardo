import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_instance_status, vardo_list_tasks and vardo_update_now exist only for an admin-scoped token held by a live instance admin.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => true),
  updateStatus: vi.fn(),
  health: vi.fn(),
  snapshot: vi.fn(),
  loops: vi.fn(),
  incidents: vi.fn(),
  heartbeats: vi.fn(),
  workers: vi.fn(),
  updateNow: vi.fn(),
  UpdateBlockedError: class UpdateBlockedError extends Error {},
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/self-update/status", () => ({ getUpdateStatus: h.updateStatus }));
vi.mock("@/lib/config/health", () => ({ getSystemHealth: h.health, sanitizeError: (s: string) => s }));
vi.mock("@/lib/attention/infrastructure", () => ({ getInfrastructureSnapshot: h.snapshot }));
vi.mock("@/lib/attention/infrastructure-rows", () => ({ infrastructureRows: () => [] }));
vi.mock("@/lib/incidents/host", () => ({ listOpenHostIncidents: h.incidents }));
vi.mock("@/lib/worker/status", () => ({ readLoopStatus: h.loops }));
vi.mock("@/lib/worker/mode", () => ({ workerMode: () => "external", workerExpected: () => true, WORKER_FRESH_MS: 90_000 }));
vi.mock("@/lib/worker/presence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worker/presence")>()),
  readWorkers: h.workers,
}));
vi.mock("@/lib/worker/watch", () => ({ readHostHeartbeats: h.heartbeats, watchdogSilent: () => false }));
vi.mock("@/lib/self-update/runner", () => ({ UpdateBlockedError: h.UpdateBlockedError }));
vi.mock("@/lib/self-update/update-now", () => ({ updateNow: h.updateNow }));

import { registerInstanceStatusTools } from "@/lib/mcp/tools/instance-status";
import { registerUpdateNow } from "@/lib/mcp/tools/update-now";

const NOW = new Date("2026-10-13T12:00:00Z");

function loop(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    roles: ["web", "worker"],
    singleton: true,
    feature: null,
    enabled: true,
    runningHere: true,
    lease: { holder: "worker:1", epoch: 1, expiresAt: NOW.toISOString(), live: true },
    state: "ok",
    stale: false,
    lastTickAt: NOW.toISOString(),
    lastOkAt: NOW.toISOString(),
    lastError: null,
    consecutiveFailures: 0,
    intervalMs: 30_000,
    lastHolder: "worker:1",
    ...over,
  };
}

function tools(context = adminContext) {
  const found = captureTools((s, c) => {
    registerInstanceStatusTools(s, c);
    registerUpdateNow(s, c);
  }, context);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(true);
  h.updateStatus.mockResolvedValue({
    selfDeploy: true,
    current: { version: "1.2.0", sha: "abc1234" },
    policy: { mode: "notify" },
    channel: "main",
    update: { hasUpdate: true, targetLabel: "1.3.0", commitsBehind: 4 },
    run: { state: "failed", trigger: "manual", startedAt: NOW.toISOString(), toLabel: "1.2.5", error: "verify failed" },
    active: null,
    rollout: null,
  });
  h.health.mockResolvedValue({
    services: [{ name: "Redis", status: "healthy", latencyMs: 2, checkedAt: "x", logsHref: "/apps/x/logs" }],
    resources: [{ name: "Disk", percent: 91, status: "critical", detail: "9 GB / 10 GB", current: 1, total: 2 }],
  });
  h.snapshot.mockResolvedValue({});
  h.incidents.mockResolvedValue([{ kind: "host.worker-down", title: "Worker is down", severity: "critical", openedAt: NOW, updatedAt: NOW }]);
  h.heartbeats.mockResolvedValue({ workerAt: NOW, workerReady: true, consoleAt: NOW, watchdogAt: NOW, now: NOW });
  h.workers.mockResolvedValue({ now: NOW, rows: [{ id: "w1", role: "worker", slot: "blue", gitSha: "abc", startedAt: NOW, heartbeatAt: NOW, readyAt: NOW, drainingAt: null, inFlight: ["backup-tick"] }] });
  h.loops.mockResolvedValue({
    instance: "web:1",
    leases: true,
    checkedAt: NOW.toISOString(),
    loops: [
      loop("zeta"),
      loop("backup-tick", { state: "failing", lastError: "boom", consecutiveFailures: 3 }),
      loop("cron-tick", { state: "stale", stale: true }),
      loop("digest", { enabled: false, state: "never" }),
    ],
  });
});

describe("admin gating", () => {
  it("registers nothing without the admin scope", () => {
    expect(tools(plainContext).size).toBe(0);
  });

  it.each(["vardo_instance_status", "vardo_list_tasks", "vardo_update_now"])("%s refuses once the user is no longer an instance admin", async (name) => {
    h.instanceAdmin.mockResolvedValue(false);
    const res = await tools().get(name)!({});
    expect(res.isError).toBe(true);
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.loops).not.toHaveBeenCalled();
    expect(h.updateNow).not.toHaveBeenCalled();
  });
});

describe("vardo_instance_status", () => {
  it("returns update, health, worker and incident sections without log links", async () => {
    const body = toolBody(await tools().get("vardo_instance_status")!({}));
    expect(body.update).toMatchObject({ version: "1.2.0", channel: "main", mode: "notify", available: { version: "1.3.0" }, lastRun: { error: "verify failed" } });
    expect(body.health.services).toEqual([{ name: "Redis", status: "healthy", latencyMs: 2, error: null }]);
    expect(body.health.resources[0]).toMatchObject({ name: "Disk", status: "critical" });
    expect(body.worker).toMatchObject({ ready: true, watchdog: { silent: false } });
    expect(body.worker.workers[0]).toMatchObject({ id: "w1", inFlight: ["backup-tick"] });
    expect(body.hostIncidents).toEqual([{ kind: "host.worker-down", title: "Worker is down", severity: "critical", openedAt: NOW.toISOString() }]);
  });

  it("lists live and recently stopped workers, newest beat first, and drops long-stopped ones", async () => {
    const worker = (id: string, beatAgoMin: number, draining: boolean) => ({
      id, role: "all", slot: "blue", gitSha: "abc", startedAt: NOW, readyAt: NOW,
      heartbeatAt: new Date(NOW.getTime() - beatAgoMin * 60_000),
      drainingAt: draining ? NOW : null,
      inFlight: [],
    });
    h.workers.mockResolvedValue({
      now: NOW,
      rows: [worker("stopped-2h", 120, true), worker("stopped-20m", 20, true), worker("draining", 0, true), worker("live", 0.1, false)],
    });
    const body = toolBody(await tools().get("vardo_instance_status")!({}));
    expect(body.worker.workers.map((w: { id: string; present: boolean }) => [w.id, w.present])).toEqual([
      ["draining", false],
      ["live", true],
      ["stopped-20m", false],
    ]);
  });

  it("reports a failing section instead of failing the call", async () => {
    h.health.mockRejectedValue(new Error("docker unreachable"));
    const res = await tools().get("vardo_instance_status")!({});
    expect(res.isError).toBeUndefined();
    const body = toolBody(res);
    expect(body.health).toEqual({ unavailable: "docker unreachable" });
    expect(body.update.version).toBe("1.2.0");
  });
});

describe("vardo_list_tasks", () => {
  it("lists stale and failing loops first and marks in-flight ones", async () => {
    const body = toolBody(await tools().get("vardo_list_tasks")!({ onlyProblems: false, limit: 20 }));
    expect(body.loops.map((l: { name: string }) => l.name)).toEqual(["cron-tick", "backup-tick", "zeta", "digest"]);
    expect(body.loops[0]).toMatchObject({ stale: true, state: "stale" });
    expect(body.loops[1]).toMatchObject({ consecutiveFailures: 3, lastError: "boom", inFlight: true, holder: "worker:1" });
    expect(body.summary).toEqual({ total: 4, stale: 1, failing: 1, neverRan: 0, disabled: 1 });
  });

  it("hides healthy and disabled loops with onlyProblems", async () => {
    const body = toolBody(await tools().get("vardo_list_tasks")!({ onlyProblems: true, limit: 20 }));
    expect(body.loops.map((l: { name: string }) => l.name)).toEqual(["cron-tick", "backup-tick"]);
  });

  it("caps the list and says so", async () => {
    const body = toolBody(await tools().get("vardo_list_tasks")!({ onlyProblems: false, limit: 2 }));
    expect(body.loops).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });
});

describe("vardo_update_now", () => {
  it("starts the update as the token's user", async () => {
    h.updateNow.mockResolvedValue({ ok: true, deploymentId: "d1", message: "Updating Vardo to 1.3.0." });
    const body = toolBody(await tools().get("vardo_update_now")!({}));
    expect(h.updateNow).toHaveBeenCalledWith("u1");
    expect(body).toMatchObject({ ok: true, deploymentId: "d1" });
  });

  it("returns a blocked update as an error", async () => {
    h.updateNow.mockRejectedValue(new h.UpdateBlockedError("An update is already running"));
    const res = await tools().get("vardo_update_now")!({});
    expect(res.isError).toBe(true);
    expect(toolBody(res).error).toBe("An update is already running");
  });
});
