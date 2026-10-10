import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateRun, UpdateState } from "@/lib/self-update/store";

const m = vi.hoisted(() => ({
  deployment: vi.fn(),
  app: vi.fn(async () => ({ id: "app_vardo", organizationId: "org_sys" })),
  setUpdateRun: vi.fn(async (_run: unknown) => {}),
  getUpdateRun: vi.fn(async () => null as unknown),
  state: { current: null as unknown as UpdateState },
  createDeployment: vi.fn(async () => "dep_rollback"),
  requestDeploy: vi.fn(async () => ({})),
  triggerSelfDeploy: vi.fn(async (_opts: unknown) => ({ deploymentId: "dep_new" })),
  dump: vi.fn(async () => "/opt/vardo/lifecycle/backups/pre-update.sql.gz"),
  unhealthy: { current: [] as string[] },
  emit: vi.fn(),
  buildSha: { current: "4f1a9b2c0d" },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      deployments: { findFirst: m.deployment },
      apps: { findFirst: m.app },
    },
  },
}));
vi.mock("@/lib/self-update/store", () => ({
  getUpdateRun: m.getUpdateRun,
  setUpdateRun: m.setUpdateRun,
  getUpdateState: vi.fn(async () => m.state.current),
  getUpdatePolicy: vi.fn(),
  updateState: vi.fn(async (change: (s: UpdateState) => UpdateState) => {
    m.state.current = change(m.state.current);
    return m.state.current;
  }),
}));
vi.mock("@/lib/docker/deploy", () => ({ createDeployment: m.createDeployment }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: m.requestDeploy }));
vi.mock("@/lib/lifecycle/deploy-request", () => ({ triggerSelfDeploy: m.triggerSelfDeploy }));
vi.mock("@/lib/self-update/dump", () => ({ dumpVardoDatabase: m.dump }));
vi.mock("@/lib/config/health", () => ({
  getSystemHealth: vi.fn(async () => ({
    services: m.unhealthy.current.map((name) => ({ name, status: "unhealthy" })),
  })),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: vi.fn(async () => ["org1"]) }));
vi.mock("@/lib/redis-lock", () => ({ acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: vi.fn() }));
vi.mock("@/lib/paths", async (orig) => ({ ...(await orig<typeof import("@/lib/paths")>()), isSelfDeployLayout: () => true }));
vi.mock("@/lib/version", async (orig) => ({
  ...(await orig<typeof import("@/lib/version")>()),
  getBuildSha: () => m.buildSha.current,
}));

import { advanceRun, startUpdate, UpdateBlockedError } from "@/lib/self-update/runner";

const NOW = Date.parse("2026-10-09T03:30:00Z");

const run = (over: Partial<UpdateRun> = {}): UpdateRun => ({
  id: "run1",
  trigger: "auto",
  state: "deploying",
  startedAt: new Date(NOW - 10 * 60_000).toISOString(),
  deploymentId: "dep_new",
  previousDeploymentId: "dep_old",
  fromSha: "e36c2e3aa1",
  toSha: "4f1a9b2c0d5e",
  toLabel: "v0.2.0",
  channel: "releases",
  dumpFile: null,
  ...over,
});

const lastRun = () => m.setUpdateRun.mock.calls.at(-1)?.[0] as UpdateRun | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  m.state.current = { failedTargets: [], approval: null, lastSkip: null, versionSince: null };
  m.unhealthy.current = [];
  m.buildSha.current = "4f1a9b2c0d";
  m.getUpdateRun.mockResolvedValue(null);
});

describe("advanceRun", () => {
  it("starts verifying on the new console once the deploy succeeds", async () => {
    m.deployment.mockResolvedValue({ status: "success", gitSha: "4f1a9b2c0d5e6f" });
    await advanceRun(run(), NOW);
    expect(lastRun()).toMatchObject({ state: "verifying", passes: 0, fails: 0 });
  });

  it("leaves verification to the new console when this one is the old build", async () => {
    m.buildSha.current = "e36c2e3aa1";
    m.deployment.mockResolvedValue({ status: "success", gitSha: "4f1a9b2c0d5e6f" });
    await advanceRun(run(), NOW);
    expect(m.setUpdateRun).not.toHaveBeenCalled();
  });

  it("records a failed deploy and skips that target next time", async () => {
    m.deployment.mockResolvedValue({ status: "failed", gitSha: null });
    await advanceRun(run(), NOW);
    expect(lastRun()).toMatchObject({ state: "failed" });
    expect(m.state.current.failedTargets).toEqual(["4f1a9b2c0d5e"]);
  });

  it("rolls back through the engine after repeated unhealthy checks, and says so", async () => {
    m.unhealthy.current = ["PostgreSQL"];
    await advanceRun(run({ state: "verifying", verifyStartedAt: new Date(NOW - 120_000).toISOString(), passes: 1, fails: 2 }), NOW);

    expect(m.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_vardo", trigger: "rollback", rollback: { targetDeploymentId: "dep_old" } }),
    );
    expect(lastRun()).toMatchObject({ state: "rolling-back", rollbackDeploymentId: "dep_rollback" });
    expect(m.emit).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ type: "system.update-failed", rolledBack: true, step: "post-update health check" }),
    );
    expect(m.state.current.failedTargets).toEqual(["4f1a9b2c0d5e"]);
  });

  it("marks the update verified after a clean window", async () => {
    await advanceRun(run({ state: "verifying", verifyStartedAt: new Date(NOW - 6 * 60_000).toISOString(), passes: 4, fails: 0 }), NOW);
    expect(lastRun()).toMatchObject({ state: "verified" });
  });

  it("finishes once the rollback deploy succeeds", async () => {
    m.deployment.mockResolvedValue({ status: "success", gitSha: "e36c2e3aa1" });
    await advanceRun(run({ state: "rolling-back", rollbackDeploymentId: "dep_rollback" }), NOW);
    expect(lastRun()).toMatchObject({ state: "rolled-back" });
  });
});

describe("startUpdate", () => {
  const release = {
    channel: "releases" as const,
    localSha: "e36c2e3",
    targetSha: "4f1a9b2c0d5e6f708192a3b4c5d6e7f809102132",
    targetLabel: "v0.2.0",
    commitsBehind: 9,
    hasUpdate: true,
    url: "https://github.com/joeyyax/vardo/releases/tag/v0.2.0",
  };

  it("dumps first, then pins the release commit", async () => {
    m.deployment.mockResolvedValue({ id: "dep_old" });
    const r = await startUpdate({ trigger: "auto", channel: "releases", update: release });
    expect(m.dump).toHaveBeenCalled();
    expect(m.triggerSelfDeploy).toHaveBeenCalledWith({ triggeredBy: undefined, gitSha: release.targetSha });
    expect(r).toMatchObject({ state: "deploying", deploymentId: "dep_new", previousDeploymentId: "dep_old", toLabel: "v0.2.0" });
  });

  it("refuses Auto without a dump", async () => {
    m.dump.mockRejectedValueOnce(new Error("pg_dump exited 1"));
    await expect(startUpdate({ trigger: "auto", channel: "releases", update: release })).rejects.toBeInstanceOf(UpdateBlockedError);
    expect(m.triggerSelfDeploy).not.toHaveBeenCalled();
  });

  it("lets Update now go ahead without a dump, on main's tip", async () => {
    m.dump.mockRejectedValueOnce(new Error("pg_dump exited 1"));
    await startUpdate({ trigger: "manual", triggeredBy: "user1", channel: "main", update: null });
    expect(m.triggerSelfDeploy).toHaveBeenCalledWith({ triggeredBy: "user1", gitSha: undefined });
  });

  it("won't start a second update or step back from the latest release", async () => {
    m.getUpdateRun.mockResolvedValueOnce(run({ startedAt: new Date().toISOString() }));
    await expect(startUpdate({ trigger: "manual", channel: "main", update: null })).rejects.toThrow("already running");
    await expect(startUpdate({ trigger: "manual", channel: "releases", update: { ...release, hasUpdate: false } })).rejects.toThrow(
      "Already on the latest release",
    );
  });
});
