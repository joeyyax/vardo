import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock, execFileAsyncMock, execFileMock, restartPolicyMock, notifyMock } = vi.hoisted(() => {
  const dbMock = {
    update: vi.fn().mockImplementation(() => {
      const where = vi.fn().mockResolvedValue(undefined);
      return { set: vi.fn().mockReturnValue({ where }) };
    }),
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

const OPTS = {
  appId: "app-1",
  appName: "my-app",
  organizationId: "org-1",
  deploymentId: "deploy-1",
  currentSlot: "green" as const,
  previousSlot: "blue" as const,
  envName: "production",
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
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("restores the previous slot and marks the deployment rolled back", async () => {
    await expect(performRollback(OPTS)).resolves.toBe(true);

    expect(indexOfCall(isUpOfBlue)).toBeGreaterThanOrEqual(0);
    expect(restartPolicyMock.restoreSlotRestart).toHaveBeenCalled();
    expect(restartPolicyMock.demoteStandbyRestart).toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalled();
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
    // No bookkeeping is written for a rollback that did not happen.
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(notifyMock.emit).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ rollbackSuccess: false }),
    );
  });
});
