// ---------------------------------------------------------------------------
// The swap demotes the old slot to `restart: no` before stopping it. Anything
// that leaves the old slot serving after that demote has to put the policy back,
// or the slot never returns from a daemon restart.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, restartPolicyMock, cutoverMock, order, volumeLimitsMock } =
  vi.hoisted(() => {
    const order: string[] = [];

    const dbMock = {
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
    };

    // The source calls promisify(execFile), which resolves through execFile's
    // nodejs.util.promisify.custom symbol.
    const execFileAsyncMock = vi.fn();
    const execFileMock = vi.fn();
    Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
      value: execFileAsyncMock,
      configurable: true,
      writable: true,
    });

    return {
      volumeLimitsMock: { checkVolumeLimits: vi.fn(async () => {}) },
      order,
      dbMock,
      execFileAsyncMock,
      execFileMock,
      restartPolicyMock: {
        demoteStandbyRestart: vi.fn(async () => { order.push("demote"); }),
        restoreSlotRestart: vi.fn(async () => { order.push("restore-policy"); }),
      },
      cutoverMock: {
        clearCutoverPin: vi.fn(async () => { order.push("clear-pin"); }),
        holdSlot: vi.fn(async () => ({ held: false, release: async () => {} })),
        NO_HOLD: { held: false, release: async () => {} },
        guardCutover: vi.fn(async () => {
          order.push("pin");
          return { pinned: true, release: async () => { order.push("unpin"); } };
        }),
      },
    };
  });

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/memory-headroom", () => ({ overlapFitsNow: vi.fn(async () => true) }));
vi.mock("@/lib/docker/restart-policy", () => restartPolicyMock);
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/deploy-steps/volume-limits", () => volumeLimitsMock);
vi.mock("@/lib/docker/client", () => ({ ensureNetwork: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
  getTraefikRoutedServices: vi.fn().mockReturnValue(new Set(["web"])),
}));
vi.mock("@/lib/docker/deploy-steps/bind-mount-ownership", () => ({
  prepareBindMountOwnership: vi.fn().mockResolvedValue(undefined),
  bindMountHostSource: vi.fn(),
  numericUid: vi.fn(),
}));

import { swap } from "@/lib/docker/deploy-steps/swap";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { createStageTimings } from "@/lib/docker/stage-timings";

/** Docker argv for each execFile call, in order. */
function calls(): string[][] {
  return execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
}

const isOldSlotStop = (a: string[]) =>
  a.includes("stop") && a.includes("app-production-blue");
const isOldSlotUp = (a: string[]) => a.includes("up") && a.includes("app-production-blue");

function composeFile(opts: { ports?: boolean } = {}): ComposeFile {
  return {
    services: {
      web: {
        name: "web",
        image: "nginx",
        ...(opts.ports ? { ports: ["8080:80"] } : {}),
        labels: { "traefik.enable": "true" },
      },
    },
  } as unknown as ComposeFile;
}

function context(
  overrides: { appName?: string; compose?: ComposeFile; activeSlot?: "blue" | null } = {},
): DeployContext {
  const logLines: string[] = [];
  const appName = overrides.appName ?? "app";
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: appName, healthCheckTimeout: null, domains: [] },
    envName: "production",
    compose: overrides.compose ?? composeFile(),
    builtImageRefs: [],
    appDir: `/opt/vardo/apps/${appName}/production`,
    slotDir: `/opt/vardo/apps/${appName}/production/green`,
    newProjectName: `${appName}-production-green`,
    activeSlot: overrides.activeSlot === undefined ? "blue" : overrides.activeSlot,
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => { logLines.push(line); return line; },
    stage: () => {},
    checkAbort: () => {},
    timer: createStageTimings(),
    startTime: Date.now(),
  } as unknown as DeployContext;
}

/** Docker answers every `ps` with one healthy container; everything else is a no-op. */
function dockerHealthy() {
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "healthy" }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("swap — old slot restore after a failed stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });

  it("restores the restart policy when the stop threw after the demote", async () => {
    // A published host port forces stop-then-start, so the stop runs before the
    // new slot comes up and its failure is followed by a failing `up`.
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (isOldSlotStop(args)) throw new Error("docker daemon unreachable");
      if (args.includes("up") && args.includes("app-production-green")) {
        throw new Error("port is already allocated");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(swap(context({ compose: composeFile({ ports: true }) }))).rejects.toThrow(
      "docker compose up (green) failed",
    );

    expect(restartPolicyMock.demoteStandbyRestart).toHaveBeenCalled();
    expect(restartPolicyMock.restoreSlotRestart).toHaveBeenCalled();
    expect(calls().some(isOldSlotUp)).toBe(true);
  });

  it("still restores when the stop succeeded", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("up") && args.includes("app-production-green")) {
        throw new Error("port is already allocated");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(swap(context({ compose: composeFile({ ports: true }) }))).rejects.toThrow(
      "docker compose up (green) failed",
    );

    expect(restartPolicyMock.restoreSlotRestart).toHaveBeenCalled();
  });

  it("restores nothing on a first deploy, where no old slot was touched", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("up") && args.includes("app-production-green")) {
        throw new Error("port is already allocated");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      swap(context({ activeSlot: null, compose: composeFile({ ports: true }) })),
    ).rejects.toThrow("docker compose up (green) failed");

    expect(restartPolicyMock.demoteStandbyRestart).not.toHaveBeenCalled();
    expect(restartPolicyMock.restoreSlotRestart).not.toHaveBeenCalled();
  });
});

describe("swap — an old slot that would not stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });

  /** Healthy `ps`, and every stop fails with `message`. */
  function stopFailsWith(message: string) {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("stop")) throw new Error(message);
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify({ Service: "web", Name: "web-1", State: "running", Health: "healthy" }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("raises unfinished work when the stop failed and the old slot kept serving", async () => {
    stopFailsWith("docker daemon unreachable");

    const ctx = context({ compose: composeFile({ ports: true }) });
    await expect(swap(ctx)).resolves.toBeTruthy();

    expect(ctx.unfinished).toEqual([
      "the old slot (blue) is still running — docker daemon unreachable",
    ]);
  });

  it("hands the overlapping stop to post-deploy, which reports its failure", async () => {
    stopFailsWith("docker daemon unreachable");

    const ctx = context();
    await swap(ctx);

    expect(ctx.unfinished).toBeUndefined();
    expect(ctx.stopOldSlotEndsDeploy).toBe(false);
    await expect(ctx.stopOldSlot!()).resolves.toEqual({
      ok: false,
      message: "docker daemon unreachable",
    });
  });

  it("raises nothing when the containers were already gone", async () => {
    stopFailsWith("Error response from daemon: No such container: app-production-blue-web-1");

    const ctx = context();
    await swap(ctx);

    expect(ctx.unfinished).toBeUndefined();
  });

  it("raises nothing when the stop worked", async () => {
    dockerHealthy();

    const ctx = context();
    await swap(ctx);

    expect(ctx.unfinished).toBeUndefined();
  });

  it("hands a failed stop back to post-deploy on the self-deploy", async () => {
    stopFailsWith("docker daemon unreachable");

    const ctx = context({ appName: "vardo" });
    await swap(ctx);

    // Deferred, so the swap itself raises nothing — post-deploy owns the outcome.
    expect(ctx.unfinished).toBeUndefined();
    await expect(ctx.stopOldSlot!()).resolves.toEqual({
      ok: false,
      message: "docker daemon unreachable",
    });
  });
});

describe("swap — cutover pin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    dockerHealthy();
  });

  it("clears a leaked pin at the top of every deploy", async () => {
    await swap(context());
    expect(cutoverMock.clearCutoverPin).toHaveBeenCalledWith("app", "production");
  });

  it("routes away from the old slot before stopping it", async () => {
    const ctx = context();
    await swap(ctx);
    expect(order).toEqual(["clear-pin"]);

    await ctx.stopOldSlot!();
    expect(order).toEqual(["clear-pin", "pin", "demote", "unpin"]);
  });

  it("pins the self-deploy too, at the stop post-deploy defers to the end", async () => {
    const ctx = context({ appName: "vardo" });
    await swap(ctx);

    // Deferred: the stop is handed to post-deploy, so nothing has happened yet.
    expect(ctx.stopOldSlot).toBeTypeOf("function");
    expect(order).toEqual(["clear-pin"]);

    await ctx.stopOldSlot!();
    expect(cutoverMock.guardCutover).toHaveBeenCalledOnce();
    expect(order).toEqual(["clear-pin", "pin", "demote", "unpin"]);
  });

  it("does not pin when the old slot was stopped before the new one started", async () => {
    await expect(swap(context({ compose: composeFile({ ports: true }) }))).resolves.toBeTruthy();
    expect(cutoverMock.guardCutover).not.toHaveBeenCalled();
  });
});

describe("swap — hold pin on the old slot", () => {
  const isNewSlotUp = (a: string[]) => a.includes("up") && a.includes("app-production-green");
  const isNewSlotDown = (a: string[]) => a.includes("down") && a.includes("app-production-green");

  /** Docker that records the new slot's up and down, with `ps` reporting `state`. */
  function dockerRecording(state: "running" | "exited", opts: { upFails?: boolean } = {}) {
    let started = false;
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (isNewSlotUp(args)) {
        order.push("up");
        started = true;
        if (opts.upFails) throw new Error("port is already allocated");
      }
      if (isNewSlotDown(args) && started) order.push("down");
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify({ Service: "web", Name: "app-production-green-web-1", State: state, Health: state === "running" ? "healthy" : "" }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    cutoverMock.holdSlot.mockImplementation(async () => {
      order.push("hold");
      return { held: true, release: async () => { order.push("release-hold"); } };
    });
  });

  it("holds the old slot before the new one starts and keeps it through the health wait", async () => {
    dockerRecording("running");
    const ctx = await swap(context());

    expect(cutoverMock.holdSlot).toHaveBeenCalledWith(
      expect.objectContaining({ appName: "app", envName: "production", projectName: "app-production-blue" }),
    );
    expect(order).toEqual(["clear-pin", "hold", "up"]);
    expect(ctx.releaseHold).toBeTypeOf("function");
  });

  it("swaps the hold for the cutover pin, never removing it in between", async () => {
    dockerRecording("running");
    const ctx = await swap(context());
    await ctx.stopOldSlot!();

    expect(order).toEqual(["clear-pin", "hold", "up", "pin", "demote", "unpin"]);
    expect(ctx.releaseHold).toBeUndefined();
  });

  it("releases the hold after tearing down a new slot that fails its health check", async () => {
    dockerRecording("exited");
    const ctx = context();
    await expect(swap(ctx)).rejects.toThrow(/did not become healthy/);

    expect(order).toEqual(["clear-pin", "hold", "up", "down", "release-hold"]);
    expect(ctx.releaseHold).toBeUndefined();
  });

  it("tags container logs as a crash only when the slot crashed", async () => {
    dockerRecording("exited");
    const recorded = execFileAsyncMock.getMockImplementation()!;
    execFileAsyncMock.mockImplementation(async (cmd: string, args: string[]) =>
      args.includes("logs") ? { stdout: "web-1 | boom", stderr: "" } : recorded(cmd, args),
    );
    const ctx = context();

    await expect(swap(ctx)).rejects.toThrow("green slot did not become healthy: web crashed (exited)");
    const lines = (ctx as unknown as { logLines: string[] }).logLines;
    expect(lines).toContain("[deploy][crash] web-1 | boom");
  });

  it("releases the hold when compose up fails", async () => {
    dockerRecording("running", { upFails: true });
    await expect(swap(context())).rejects.toThrow(/compose up/);

    expect(order).toEqual(["clear-pin", "hold", "up", "down", "release-hold"]);
  });

  it("releases the hold when the deploy is cancelled before the health wait", async () => {
    dockerRecording("running");
    const ctx = context();
    ctx.checkAbort = () => {
      if (order.includes("up")) throw new Error("aborted");
    };
    await expect(swap(ctx)).rejects.toThrow("aborted");

    expect(order).toEqual(["clear-pin", "hold", "up", "release-hold"]);
  });

  it("does not hold when the slots can't overlap", async () => {
    dockerRecording("running");
    await swap(context({ compose: composeFile({ ports: true }) }));
    expect(cutoverMock.holdSlot).not.toHaveBeenCalled();
  });

  it("does not hold on a first deploy", async () => {
    dockerRecording("running");
    await swap(context({ activeSlot: null }));
    expect(cutoverMock.holdSlot).not.toHaveBeenCalled();
  });

  it("leaves no release behind when Traefik never confirmed the hold", async () => {
    cutoverMock.holdSlot.mockResolvedValueOnce({ held: false, release: async () => {} });
    dockerRecording("running");
    const ctx = await swap(context());
    expect(ctx.releaseHold).toBeUndefined();
  });
});

describe("swap — volume limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    dockerHealthy();
  });

  it("blocks the deploy before the old slot is touched", async () => {
    const { DeployBlockedError } = await import("@/lib/docker/errors");
    volumeLimitsMock.checkVolumeLimits.mockRejectedValueOnce(new DeployBlockedError("over limit"));

    await expect(swap(context({ compose: composeFile({ ports: true }) }))).rejects.toThrow("over limit");

    expect(calls().some(isOldSlotStop)).toBe(false);
    expect(restartPolicyMock.demoteStandbyRestart).not.toHaveBeenCalled();
    expect(calls().some((a) => a.includes("up"))).toBe(false);
  });
});
