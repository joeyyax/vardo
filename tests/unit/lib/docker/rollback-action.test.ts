import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const {
  dbMock,
  inserts,
  updates,
  execFileAsyncMock,
  execFileMock,
  restartPolicyMock,
  notifyMock,
} = vi.hoisted(() => {
  const inserts: Record<string, unknown>[] = [];
  const updates: { values: Record<string, unknown>; cond: unknown }[] = [];

  const dbMock = {
    query: {
      deployments: {
        findFirst: vi.fn().mockResolvedValue({ gitSha: "abc1234", gitMessage: "the good one" }),
      },
    },
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        inserts.push(values);
        return Promise.resolve();
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation((cond: unknown) => {
          updates.push({ values, cond });
          return Promise.resolve();
        }),
      })),
    })),
  };

  // The source calls promisify(execFile), which resolves through execFile's
  // nodejs.util.promisify.custom symbol.
  const execFileAsyncMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return {
    dbMock,
    inserts,
    updates,
    execFileAsyncMock,
    execFileMock,
    restartPolicyMock: {
      demoteStandbyRestart: vi.fn().mockResolvedValue(undefined),
      restoreSlotRestart: vi.fn().mockResolvedValue(undefined),
    },
    notifyMock: { emit: vi.fn() },
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("nanoid", () => ({ nanoid: () => "rollback-1" }));
vi.mock("@/lib/docker/restart-policy", () => restartPolicyMock);
vi.mock("@/lib/notifications/dispatch", () => notifyMock);
vi.mock("@/lib/docker/client", () => ({ listContainers: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/docker/compose", () => ({ slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]) }));
vi.mock("@/lib/docker/shared-project", () => ({ readSlotPartition: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/stream/producer", () => ({
  addEvent: vi.fn().mockResolvedValue("id"),
  addDeployLog: vi.fn().mockResolvedValue("id"),
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("fs/promises", () => ({
  rm: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { performRollback, slotIsDown, slotContainerIds } from "@/lib/docker/rollback-monitor";
import { isTerminalStageEvent } from "@/lib/docker/deploy-logger";
import { addDeployLog } from "@/lib/stream/producer";

const OPTS = {
  appId: "app-1",
  appName: "my-app",
  organizationId: "org-1",
  deploymentId: "deploy-1",
  currentSlot: "green" as const,
  previousSlot: "blue" as const,
  envName: "production",
  environmentId: "env-1",
};

/** Docker argv for each execFile call, in order. */
function calls(): string[][] {
  return execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
}

function indexOfCall(match: (args: string[]) => boolean): number {
  return calls().findIndex(match);
}

const isStopOfGreen = (a: string[]) => a.includes("stop") && a.includes("my-app-production-green");
const isUpOfBlue = (a: string[]) => a.includes("up") && a.includes("my-app-production-blue");
const isUpOfGreen = (a: string[]) => a.includes("up") && a.includes("my-app-production-green");

/** Whether a drizzle condition was built from the given id. */
function mentions(node: unknown, id: string, depth = 0, seen = new Set<unknown>()): boolean {
  if (node === id) return true;
  if (depth > 8 || node === null || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  return Object.values(node as Record<string, unknown>).some((v) => mentions(v, id, depth + 1, seen));
}

function updatesFor(id: string) {
  return updates.filter((u) => mentions(u.cond, id));
}

/** Stage events written to a deployment's stream, in order. */
function stageEvents(deployId: string) {
  return vi
    .mocked(addDeployLog)
    .mock.calls.filter(([id, entry]) => id === deployId && entry.line.startsWith("[stage]"))
    .map(([, entry]) => ({ stage: entry.stage, status: entry.status }));
}

describe("slotContainerIds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the ids docker reports", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "abc\ndef\n", stderr: "" });
    await expect(slotContainerIds("proj", false)).resolves.toEqual(["abc", "def"]);
  });

  it("returns null when docker cannot be reached", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("no such socket"));
    await expect(slotContainerIds("proj", true)).resolves.toBeNull();
  });
});

describe("slotIsDown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is true only when the project has no running containers", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await expect(slotIsDown("proj")).resolves.toBe(true);

    execFileAsyncMock.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" });
    await expect(slotIsDown("proj")).resolves.toBe(false);
  });

  it("is null rather than true when docker errors", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(slotIsDown("proj")).resolves.toBeNull();
  });
});

describe("performRollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserts.length = 0;
    updates.length = 0;
    // `docker ps` answers for the verify phase; everything else is silent.
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "ps" ? { stdout: "abc123\n", stderr: "" } : { stdout: "", stderr: "" },
    );
  });

  it("restores the previous slot and marks the deployment rolled back", async () => {
    await expect(performRollback(OPTS)).resolves.toBe(true);

    expect(indexOfCall(isUpOfBlue)).toBeGreaterThanOrEqual(0);
    expect(restartPolicyMock.restoreSlotRestart).toHaveBeenCalled();
    expect(restartPolicyMock.demoteStandbyRestart).toHaveBeenCalled();
    expect(updatesFor("deploy-1")).toEqual([
      { values: { status: "rolled_back" }, cond: expect.anything() },
    ]);
  });

  it("records the rollback as its own deployment", async () => {
    await performRollback(OPTS);

    expect(inserts).toEqual([
      expect.objectContaining({
        id: "rollback-1",
        appId: "app-1",
        status: "running",
        trigger: "rollback",
        rollbackFromId: "deploy-1",
        slot: "blue",
        environmentId: "env-1",
        // The commit the restored slot is running.
        gitSha: "abc1234",
      }),
    ]);
  });

  it("leaves the rescued deploy's duration and finish time alone", async () => {
    await performRollback(OPTS);

    for (const { values } of updatesFor("deploy-1")) {
      expect(values).not.toHaveProperty("durationMs");
      expect(values).not.toHaveProperty("finishedAt");
      expect(values).not.toHaveProperty("log");
    }
  });

  it("times the rollback row against the rollback, not the deploy", async () => {
    await performRollback(OPTS);

    const terminal = updatesFor("rollback-1").at(-1)!;
    expect(terminal.values).toMatchObject({ status: "success" });
    expect(terminal.values.durationMs).toEqual(expect.any(Number));
    expect(terminal.values.finishedAt).toBeInstanceOf(Date);
  });

  it("reports its own phases on its own stream", async () => {
    await performRollback(OPTS);

    expect(stageEvents("rollback-1")).toEqual([
      { stage: "stop", status: "running" },
      { stage: "stop", status: "success" },
      { stage: "restore", status: "running" },
      { stage: "restore", status: "success" },
      { stage: "route", status: "running" },
      { stage: "route", status: "success" },
      { stage: "verify", status: "running" },
      { stage: "verify", status: "success" },
      { stage: "done", status: "success" },
    ]);
    expect(stageEvents("deploy-1")).toEqual([]);
  });

  it("closes its stream on a terminal event", async () => {
    await performRollback(OPTS);

    const events = stageEvents("rollback-1");
    const terminal = events.filter((e) => isTerminalStageEvent(e.stage, e.status));
    expect(terminal).toEqual([{ stage: "done", status: "success" }]);
    expect(events.at(-1)).toEqual({ stage: "done", status: "success" });
  });

  it("holds the app status for the swap and hands it back", async () => {
    await performRollback(OPTS);

    const appStatuses = updatesFor("app-1")
      .map((u) => u.values.status)
      .filter(Boolean);
    expect(appStatuses[0]).toBe("deploying");
    expect(appStatuses.at(-1)).toBe("active");
  });

  it("stops the crashed slot before binding the previous one", async () => {
    await performRollback(OPTS);

    const stop = indexOfCall(isStopOfGreen);
    const up = indexOfCall(isUpOfBlue);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(up);
  });

  it("never tears the crashed slot down — it stays available to restore", async () => {
    await performRollback(OPTS);

    expect(calls().some((a) => a.includes("down"))).toBe(false);
  });

  it("puts the crashed slot back when the previous slot will not start", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (isUpOfBlue(args)) throw new Error("image missing");
      return { stdout: "", stderr: "" };
    });

    await expect(performRollback(OPTS)).resolves.toBe(false);

    // The slot we stopped is brought back rather than left dark.
    expect(indexOfCall(isUpOfGreen)).toBeGreaterThanOrEqual(0);
    // The deploy is left exactly as it recorded itself.
    expect(updatesFor("deploy-1")).toEqual([]);
    expect(notifyMock.emit).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ rollbackSuccess: false }),
    );
  });

  it("fails its own row, terminally, when the previous slot will not start", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (isUpOfBlue(args)) throw new Error("image missing");
      return { stdout: "", stderr: "" };
    });

    await performRollback(OPTS);

    const events = stageEvents("rollback-1");
    expect(events.at(-1)).toEqual({ stage: "restore", status: "failed" });
    expect(isTerminalStageEvent("restore", "failed")).toBe(true);
    expect(updatesFor("rollback-1").at(-1)!.values).toMatchObject({ status: "failed" });
    expect(updatesFor("app-1").at(-1)!.values).toMatchObject({ status: "error" });
  });

  it("fails when the restored slot is not running after the swap", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    await expect(performRollback(OPTS)).resolves.toBe(false);

    const events = stageEvents("rollback-1");
    expect(events.at(-1)).toEqual({ stage: "verify", status: "failed" });
    // The deploy was still rolled away from, and still keeps its own timings.
    expect(updatesFor("deploy-1")).toEqual([
      { values: { status: "rolled_back" }, cond: expect.anything() },
    ]);
    expect(notifyMock.emit).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ rollbackSuccess: false }),
    );
  });
});
