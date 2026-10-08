// performInstantRollback flips traffic to the standby slot that stopStandbySlot
// left behind. The claim, the cutover pin and the policy check have their own
// files (instant-rollback-pin, instant-rollback-policy); this one covers the
// flip itself and every point where it must leave the active slot serving.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

const h = vi.hoisted(() => ({
  exec: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  detectActiveSlot: vi.fn(),
  assertSlot: vi.fn(),
  clearPin: vi.fn(),
  restoreRestart: vi.fn(),
  demoteRestart: vi.fn(),
  readPartition: vi.fn(),
  addEvent: vi.fn(),
  recordActivity: vi.fn(),
  fs: { rm: vi.fn(), symlink: vi.fn(), rename: vi.fn() },
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: h.exec }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/docker/slot-guard", () => ({ assertSlotWithinApp: h.assertSlot }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ claimAppForOperation: h.claim }));
vi.mock("@/lib/docker/traefik-cutover", () => ({ clearCutoverPin: h.clearPin }));
vi.mock("@/lib/docker/restart-policy", () => ({
  restoreSlotRestart: h.restoreRestart,
  demoteStandbyRestart: h.demoteRestart,
}));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn(async (dir: string) => ["-f", `${dir}/docker-compose.yml`]),
}));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: h.detectActiveSlot }));
vi.mock("@/lib/docker/shared-project", () => ({ readSlotPartition: h.readPartition }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: h.addEvent }));
vi.mock("@/lib/activity", () => ({ recordActivity: h.recordActivity }));
vi.mock("fs/promises", () => h.fs);
vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  INSTANT_ROLLBACK_HEALTH_TIMEOUT: 40,
  INSTANT_ROLLBACK_POLL_INTERVAL: 5,
}));

import { checkStandbyAvailable, performInstantRollback } from "@/lib/docker/instant-rollback";
import type { ResolvedEnv } from "@/lib/docker/resolve-env";

const ENV = { id: "env-1", name: "production", type: "production" } as ResolvedEnv;
const OPTS = { appId: "app-1", appName: "blog", organizationId: "org-1", userId: "u1", env: ENV };

type Script = {
  standbyPs?: string; // `ps -a` on the standby
  runningPs?: string; // `ps` on the standby while waiting for it
  upFails?: boolean;
};
const RUNNING = JSON.stringify({ Service: "web", Name: "blog-production-green-web-1", State: "running" });

/** Docker answers by subcommand; every call lands in `calls` as "<verb>:<project or target>". */
let calls: string[];
function fakeDocker(s: Script = {}) {
  h.exec.mockImplementation(async (_bin: string, args: string[]) => {
    const project = args[args.indexOf("-p") + 1];
    if (args[0] === "network") {
      calls.push(`disconnect:${args[4]}`);
      return { stdout: "", stderr: "" };
    }
    const verb = ["up", "stop"].find((v) => args.includes(v)) ?? (args.includes("-q") ? "ps-q" : args.includes("-a") ? "ps-a" : "ps");
    calls.push(`${verb}:${project}`);
    if (verb === "ps-a") return { stdout: s.standbyPs ?? `${RUNNING}\n`, stderr: "" };
    if (verb === "ps") return { stdout: s.runningPs ?? `${RUNNING}\n`, stderr: "" };
    if (verb === "ps-q") return { stdout: "c1\nc2\n", stderr: "" };
    if (verb === "up" && s.upFails) throw new Error("compose up failed");
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  calls = [];
  h.claim.mockResolvedValue({ release: h.release });
  h.detectActiveSlot.mockResolvedValue("blue");
  h.assertSlot.mockResolvedValue(undefined);
  h.clearPin.mockResolvedValue(undefined);
  h.readPartition.mockResolvedValue(null);
  h.addEvent.mockResolvedValue("evt");
  h.recordActivity.mockResolvedValue(undefined);
  dbMock.query.deployments.findFirst.mockResolvedValue({
    id: "dep-old",
    gitSha: "abc123",
    gitMessage: "previous release",
    environmentId: "env-1",
  });
  fakeDocker();
});

describe("performInstantRollback — the flip", () => {
  it("starts the standby, stops the active slot and reports the swap", async () => {
    const result = await performInstantRollback(OPTS);

    expect(result).toMatchObject({ success: true, fromSlot: "blue", toSlot: "green" });
    expect(calls.indexOf("up:blog-production-green")).toBeGreaterThan(-1);
    expect(calls.indexOf("stop:blog-production-blue")).toBeGreaterThan(calls.indexOf("up:blog-production-green"));
  });

  it("starts the standby without recreating containers or pulling", async () => {
    await performInstantRollback(OPTS);

    const up = h.exec.mock.calls.map((c) => c[1] as string[]).find((a) => a.includes("up"))!;
    expect(up).toEqual(expect.arrayContaining(["up", "-d", "--no-recreate", "--pull", "never"]));
  });

  it("restores the standby's restart policy and demotes the slot it leaves", async () => {
    await performInstantRollback(OPTS);

    expect(h.restoreRestart).toHaveBeenCalledWith(expect.anything(), "blog-production-green", expect.stringContaining("green"));
    expect(h.demoteRestart).toHaveBeenCalledWith(expect.anything(), "blog-production-blue", expect.stringContaining("blue"));
  });

  it("takes the active containers off the shared network before stopping them", async () => {
    await performInstantRollback(OPTS);

    expect(calls).toContain("disconnect:c1");
    expect(calls).toContain("disconnect:c2");
    expect(calls.indexOf("disconnect:c2")).toBeLessThan(calls.indexOf("stop:blog-production-blue"));
  });

  it("points current at the new slot atomically", async () => {
    await performInstantRollback(OPTS);

    expect(h.fs.symlink).toHaveBeenCalledWith("green", expect.stringMatching(/current\.tmp$/), "dir");
    expect(h.fs.rename).toHaveBeenCalledWith(expect.stringMatching(/current\.tmp$/), expect.stringMatching(/current$/));
  });

  it("records the running container and marks the app active", async () => {
    await performInstantRollback(OPTS);

    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0].set).toMatchObject({ containerName: "blog-production-green-web-1", status: "active" });
  });

  it("writes a rollback deployment that points at the release it restored", async () => {
    const result = await performInstantRollback(OPTS);

    expect(dbMock.inserts).toHaveLength(1);
    expect(dbMock.inserts[0].values).toMatchObject({
      id: result.deploymentId,
      appId: "app-1",
      status: "success",
      trigger: "rollback",
      triggeredBy: "u1",
      slot: "green",
      gitSha: "abc123",
      rollbackFromId: "dep-old",
      environmentId: "env-1",
    });
  });

  it("emits the stream event and the activity record, then releases the claim", async () => {
    const result = await performInstantRollback(OPTS);

    expect(h.addEvent).toHaveBeenCalledWith("org-1", expect.objectContaining({ appId: "app-1", deploymentId: result.deploymentId, success: true }));
    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deployment.instant_rollback", metadata: expect.objectContaining({ fromSlot: "blue", toSlot: "green" }) }),
    );
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("starts only the rotating services when the slot has a shared partition", async () => {
    h.readPartition.mockResolvedValue({ shared: { db: {} }, slotted: { web: {} } });

    await performInstantRollback(OPTS);

    const up = h.exec.mock.calls.map((c) => c[1] as string[]).find((a) => a.includes("up"))!;
    expect(up).toContain("web");
    expect(up).not.toContain("db");
  });

  it("still succeeds when the active slot will not stop", async () => {
    h.exec.mockImplementation(async (_b: string, args: string[]) => {
      if (args.includes("stop")) throw new Error("timeout");
      if (args.includes("-q")) return { stdout: "", stderr: "" };
      return { stdout: `${RUNNING}\n`, stderr: "" };
    });

    await expect(performInstantRollback(OPTS)).resolves.toMatchObject({ success: true });
  });
});

describe("performInstantRollback — refusals leave the active slot serving", () => {
  const stopsActive = () => calls.includes("stop:blog-production-blue");

  it("refuses with no active deployment and releases the claim", async () => {
    h.detectActiveSlot.mockResolvedValue(null);

    const result = await performInstantRollback(OPTS);

    expect(result).toMatchObject({ success: false, error: "No active deployment" });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("refuses when the standby has no containers, starting nothing", async () => {
    fakeDocker({ standbyPs: "" });

    const result = await performInstantRollback(OPTS);

    expect(result).toMatchObject({ success: false, fromSlot: "blue", toSlot: "green" });
    expect(result.error).toMatch(/No standby containers/);
    expect(calls.some((c) => c.startsWith("up:"))).toBe(false);
    expect(h.clearPin).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("refuses when compose cannot list the standby", async () => {
    h.exec.mockRejectedValue(new Error("docker unreachable"));

    const result = await performInstantRollback(OPTS);

    expect(result.error).toMatch(/No standby containers/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("keeps the active slot when the standby fails to start", async () => {
    fakeDocker({ upFails: true });

    const result = await performInstantRollback(OPTS);

    expect(result).toMatchObject({ success: false, error: "Couldn't start the standby" });
    expect(stopsActive()).toBe(false);
    expect(h.restoreRestart).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("stops the standby and keeps the active slot when it never reaches running", async () => {
    fakeDocker({ runningPs: JSON.stringify({ Service: "web", State: "exited" }) });

    const result = await performInstantRollback(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed to start/);
    expect(calls).toContain("stop:blog-production-green");
    expect(stopsActive()).toBe(false);
    expect(h.fs.symlink).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("does not treat one running container among several as healthy", async () => {
    fakeDocker({
      runningPs: `${RUNNING}\n${JSON.stringify({ Service: "worker", State: "restarting" })}\n`,
    });

    const result = await performInstantRollback(OPTS);

    expect(result.success).toBe(false);
    expect(stopsActive()).toBe(false);
  });

  it("releases the claim when the flip throws", async () => {
    dbMock.insert.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    await expect(performInstantRollback(OPTS)).rejects.toThrow("db down");
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe("checkStandbyAvailable", () => {
  it("reports no standby for a local environment without asking Docker", async () => {
    const out = await checkStandbyAvailable("blog", { ...ENV, type: "local" } as ResolvedEnv);

    expect(out).toMatchObject({ standbyAvailable: false, standbySlot: null });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("counts the standby's containers", async () => {
    fakeDocker({ standbyPs: `${RUNNING}\n${RUNNING}\n` });

    expect(await checkStandbyAvailable("blog", ENV)).toMatchObject({
      activeSlot: "blue",
      standbySlot: "green",
      standbyAvailable: true,
      standbyServiceCount: 2,
    });
  });

  it("falls back to blue as active and reports no standby when compose fails", async () => {
    h.detectActiveSlot.mockResolvedValue(null);
    h.exec.mockRejectedValue(new Error("nope"));

    expect(await checkStandbyAvailable("blog", ENV)).toMatchObject({
      activeSlot: "blue",
      standbyAvailable: false,
      standbyServiceCount: 0,
    });
  });
});
