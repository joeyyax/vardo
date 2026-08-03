// ---------------------------------------------------------------------------
// Start and restart are different compose commands.
//
// `stopProject` runs `compose down`, so a stopped app has no containers left
// and `compose restart` exits 0 having started nothing. These assert which
// command each prior status earns, and that the lifecycle row names it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  execFileMock,
  execFileAsyncMock,
  accessMock,
  readlinkMock,
  appsFindFirst,
  restartContainersMock,
  resolveDefaultEnvMock,
  reconcileAppNowMock,
  recordLifecycleMock,
  readSlotPartitionMock,
  setParkedMock,
} = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });
  return {
    execFileMock,
    execFileAsyncMock,
    accessMock: vi.fn(),
    readlinkMock: vi.fn(),
    appsFindFirst: vi.fn(),
    restartContainersMock: vi.fn(),
    resolveDefaultEnvMock: vi.fn(),
    reconcileAppNowMock: vi.fn(),
    recordLifecycleMock: vi.fn(),
    readSlotPartitionMock: vi.fn(),
    setParkedMock: vi.fn(),
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("fs/promises", () => ({ access: accessMock, readlink: readlinkMock }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: appsFindFirst } } } }));
vi.mock("@/lib/db/app-parked", () => ({ setParked: setParkedMock }));
vi.mock("@/lib/docker/deploy", () => ({ restartContainers: restartContainersMock }));
vi.mock("@/lib/docker/resolve-env", () => ({ resolveDefaultEnv: resolveDefaultEnvMock }));
vi.mock("@/lib/docker/status-reconcile", () => ({ reconcileAppNow: reconcileAppNowMock }));
vi.mock("@/lib/activity/lifecycle", () => ({ recordLifecycle: recordLifecycleMock }));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
}));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue("blue") }));
vi.mock("@/lib/docker/shared-project", async (original) => ({
  ...(await original<typeof import("@/lib/docker/shared-project")>()),
  readSlotPartition: readSlotPartitionMock,
}));

import { startOrRestartApp } from "@/lib/docker/start-app";

const ORG = "org-1";

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    name: "paperless",
    status: "active",
    parentAppId: null,
    composeService: null,
    ...overrides,
  };
}

function start(overrides: Record<string, unknown> = {}) {
  return startOrRestartApp({
    organizationId: ORG,
    app: app(overrides) as never,
    userId: "u1",
    trigger: "mcp",
  });
}

/** Flat docker argv of the nth compose invocation. */
function composeArgs(call = 0): string[] {
  return execFileAsyncMock.mock.calls[call][1] as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
  // No `local/` directory, and the slot directory is on disk.
  accessMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/local")) throw new Error("ENOENT");
  });
  readlinkMock.mockRejectedValue(new Error("ENOENT"));
  execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
  restartContainersMock.mockResolvedValue({ success: true, log: "ok" });
  resolveDefaultEnvMock.mockResolvedValue({ name: "production" });
  reconcileAppNowMock.mockResolvedValue("active");
  readSlotPartitionMock.mockResolvedValue(null);
});

describe("startOrRestartApp — running app", () => {
  it("restarts in place and records a restart", async () => {
    const result = await start();

    expect(restartContainersMock).toHaveBeenCalledWith("paperless", "production", undefined);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, action: "restarted" });
    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "restarted", trigger: "mcp", userId: "u1" }),
    );
  });

  it("unparks what it was asked to run", async () => {
    await start();

    expect(setParkedMock).toHaveBeenCalledWith("app-1", false);
  });

  it("records what Docker reported and how long the restart took", async () => {
    await start();

    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", durationMs: expect.any(Number) }),
    );
  });

  it("records the crash a restart came back to rather than a bare restart", async () => {
    reconcileAppNowMock.mockResolvedValue("error");

    const result = await start();

    expect(result).toMatchObject({ success: true, observed: "error" });
    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "restarted", status: "error" }),
    );
  });

  it("claims no outcome when Docker could not be read", async () => {
    reconcileAppNowMock.mockResolvedValue(null);

    await start();

    expect(recordLifecycleMock.mock.calls[0][0].status).toBeNull();
  });

  it("passes the pending config through to the row", async () => {
    await start({ needsRedeploy: true });

    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ app: expect.objectContaining({ needsRedeploy: true }) }),
    );
  });

  it("restarts a crashed app rather than bringing it up — its containers exist", async () => {
    await start({ status: "error" });

    expect(restartContainersMock).toHaveBeenCalled();
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("records nothing when the restart failed", async () => {
    restartContainersMock.mockResolvedValue({ success: false, log: "boom" });

    const result = await start();

    expect(result).toMatchObject({ success: false, action: "none", failure: "compose" });
    expect(reconcileAppNowMock).not.toHaveBeenCalled();
    expect(recordLifecycleMock).not.toHaveBeenCalled();
  });
});

describe("startOrRestartApp — stopped app", () => {
  it("brings a downed app up instead of restarting nothing", async () => {
    const result = await start({ status: "stopped" });

    expect(restartContainersMock).not.toHaveBeenCalled();
    expect(composeArgs()).toEqual([
      "compose", "-f", "docker-compose.yml",
      "-p", "paperless-production-blue",
      "up", "-d", "--no-recreate", "--pull", "never",
    ]);
    expect(result).toMatchObject({ success: true, action: "started" });
    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "started" }),
    );
  });

  it("leaves containers that are still there alone", async () => {
    await start({ status: "stopped" });

    // --no-recreate starts an exited container; without it compose replaces it.
    expect(composeArgs()).toContain("--no-recreate");
    // Nothing reaches a registry on the way back up.
    expect(composeArgs()).toContain("never");
  });

  it("treats a missing app the same as a stopped one", async () => {
    await start({ status: "missing" });

    expect(composeArgs()).toContain("up");
    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "started" }),
    );
  });

  it("asks for a deploy when nothing was ever written to disk", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));

    const result = await start({ status: "stopped" });

    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, failure: "no-slot" });
    expect(result.log).toContain("Deploy the app to bring it up");
    expect(recordLifecycleMock).not.toHaveBeenCalled();
  });

  it("claims no start when compose exited clean and nothing came up", async () => {
    reconcileAppNowMock.mockResolvedValue("missing");

    const result = await start({ status: "stopped" });

    expect(result).toMatchObject({ success: false, action: "none", observed: "missing" });
    expect(recordLifecycleMock).not.toHaveBeenCalled();
  });

  it("brings the shared services up before the slot they serve", async () => {
    readSlotPartitionMock.mockResolvedValue({ shared: { db: {} }, slotted: { web: {} } });

    await start({ status: "stopped" });

    expect(composeArgs(0)).toEqual(
      expect.arrayContaining(["-p", "paperless-production-shared", "--no-deps", "db"]),
    );
    expect(composeArgs(1)).toEqual(
      expect.arrayContaining(["-p", "paperless-production-blue", "--no-deps", "web"]),
    );
  });
});

describe("startOrRestartApp — compose child", () => {
  const child = { id: "c1", name: "paperless-db", parentAppId: "app-1", composeService: "db" };

  beforeEach(() => {
    appsFindFirst.mockResolvedValue({ id: "app-1", name: "paperless" });
  });

  it("restarts only its own service inside the parent's project", async () => {
    await start({ ...child, status: "active" });

    expect(resolveDefaultEnvMock).toHaveBeenCalledWith("app-1");
    expect(restartContainersMock).toHaveBeenCalledWith("paperless", "production", "db");
  });

  it("starts only its own service when the stack is down", async () => {
    await start({ ...child, status: "stopped" });

    expect(composeArgs()).toEqual(
      expect.arrayContaining(["-p", "paperless-production-blue", "up", "-d", "db"]),
    );
    expect(recordLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "started", app: expect.objectContaining({ composeService: "db" }) }),
    );
  });

  it("starts a shared service in the project that owns it", async () => {
    readSlotPartitionMock.mockResolvedValue({ shared: { db: {} }, slotted: { web: {} } });

    await start({ ...child, status: "stopped" });

    expect(composeArgs()).toEqual(
      expect.arrayContaining(["-p", "paperless-production-shared", "--no-deps", "db"]),
    );
  });

  it("does nothing when the parent cannot be resolved", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const result = await start({ ...child, status: "stopped" });

    expect(result).toMatchObject({ success: false, failure: "no-parent" });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(restartContainersMock).not.toHaveBeenCalled();
  });
});
