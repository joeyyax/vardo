// An app set to stop-first pulls while the old slot serves, stops it, then starts
// the new slot. A failed health check brings the old slot back.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, headroomMock, cutoverMock, state } = vi.hoisted(() => {
  const state = { greenState: "running", greenLogs: "" };

  const dbMock = {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    query: { deployments: { findFirst: vi.fn(async () => ({ status: "running" })) } },
  };

  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return {
    state,
    dbMock,
    execFileAsyncMock,
    execFileMock,
    headroomMock: { overlapFitsNow: vi.fn(async () => true) },
    cutoverMock: {
      clearCutoverPin: vi.fn(async () => {}),
      holdSlot: vi.fn(async () => ({ held: false, release: async () => {} })),
      NO_HOLD: { held: false, release: async () => {} },
      guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
    },
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/memory-headroom", () => headroomMock);
vi.mock("@/lib/docker/deploy-oom", () => ({ reportOomDuringDeploy: vi.fn(async () => {}) }));
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn(async () => {}),
  restoreSlotRestart: vi.fn(async () => {}),
}));
vi.mock("@/lib/docker/client", () => ({ ensureNetwork: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
  getTraefikRoutedServices: vi.fn().mockReturnValue(new Set()),
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

const LOCK_LINE = "scrypted-1  | IO error: lock /server/volume/scrypted.db/LOCK: Resource temporarily unavailable";

const calls = () => execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
const indexOf = (match: (args: string[]) => boolean) => calls().findIndex(match);

const isPull = (a: string[]) => a.includes("pull") && a.includes("app-production-green");
const isOldStop = (a: string[]) => a.includes("stop") && a.includes("app-production-blue");
const isNewUp = (a: string[]) => a.includes("up") && a.includes("app-production-green");
const isNewDown = (a: string[]) => a.includes("down") && a.includes("app-production-green");
const isOldRestore = (a: string[]) => a.includes("up") && a.includes("app-production-blue");

function context(overrides: { appName?: string; deployStrategy?: string; activeSlot?: string | null } = {}) {
  const logLines: string[] = [];
  const appName = overrides.appName ?? "app";
  const ctx = {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: {
      id: "app-1",
      name: appName,
      displayName: appName,
      healthCheckTimeout: null,
      deployStrategy: overrides.deployStrategy ?? "blue-green",
      domains: [],
    },
    envName: "production",
    compose: {
      services: {
        scrypted: {
          name: "scrypted",
          image: "ghcr.io/koush/scrypted",
          volumes: ["/mnt/docker/scrypted/server/volume:/server/volume"],
        },
      },
    } as unknown as ComposeFile,
    builtImageRefs: [],
    appDir: `/opt/vardo/apps/${appName}/production`,
    slotDir: `/opt/vardo/apps/${appName}/production/green`,
    newProjectName: `${appName}-production-green`,
    activeSlot: overrides.activeSlot === undefined ? "blue" : overrides.activeSlot,
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 10443,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => { logLines.push(line); return line; },
    stage: () => {},
    checkAbort: () => {},
    timer: createStageTimings(),
    startTime: Date.now(),
  } as unknown as DeployContext;
  return { ctx, logLines };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.greenState = "running";
  state.greenLogs = "";
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("logs")) return { stdout: state.greenLogs, stderr: "" };
    if (args.includes("inspect")) return { stdout: `/app-production-green-scrypted-1 0 ${state.greenState}`, stderr: "" };
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({ Service: "scrypted", Name: "app-production-green-scrypted-1", State: state.greenState, Health: "healthy" }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — stop-first", () => {
  it("leaves blue/green alone by default: the old slot stops after the new one is up", async () => {
    const { ctx } = context();
    await swap(ctx);
    expect(indexOf(isOldStop)).toBe(-1);
    expect(ctx.stopOldSlot).toBeTypeOf("function");
  });

  it("pulls first, then stops the old slot, then starts the new one", async () => {
    const { ctx } = context({ deployStrategy: "stop-first" });
    await swap(ctx);
    const pull = indexOf(isPull);
    const stop = indexOf(isOldStop);
    const up = indexOf(isNewUp);
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(pull).toBeLessThan(stop);
    expect(stop).toBeLessThan(up);
    expect(ctx.stopOldSlot).toBeUndefined();
  });

  it("skips the memory check and the cutover pin", async () => {
    await swap(context({ deployStrategy: "stop-first" }).ctx);
    expect(headroomMock.overlapFitsNow).not.toHaveBeenCalled();
    expect(cutoverMock.guardCutover).not.toHaveBeenCalled();
  });

  it("says the app is down instead of claiming the old slot keeps serving", async () => {
    const { ctx, logLines } = context({ deployStrategy: "stop-first" });
    await swap(ctx);
    const log = logLines.join("\n");
    expect(log).toContain("Stop-first deploy: stopping blue before green starts. The app is down until green is healthy");
    expect(log).not.toMatch(/keeps serving|sharing traffic/);
  });

  it("tears down the new slot, then restarts the old one, when the health check fails", async () => {
    state.greenState = "exited";
    const { ctx, logLines } = context({ deployStrategy: "stop-first" });
    await expect(swap(ctx)).rejects.toThrow(/blue was restarted on the previous version/);
    const down = calls().findLastIndex(isNewDown);
    const restore = indexOf(isOldRestore);
    expect(down).toBeGreaterThan(indexOf(isNewUp));
    expect(restore).toBeGreaterThan(down);
    expect(calls()[restore]).toEqual(expect.arrayContaining(["--no-recreate", "--pull", "never"]));
    expect(logLines).toContain("[deploy] blue restarted on the previous version");
  });

  it("says the app is down when the old slot can't be restarted", async () => {
    state.greenState = "exited";
    const base = execFileAsyncMock.getMockImplementation()!;
    execFileAsyncMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (isOldRestore(args)) throw new Error("no such image");
      return base(cmd, args);
    });
    await expect(swap(context({ deployStrategy: "stop-first" }).ctx)).rejects.toThrow(
      /blue could not be restarted, so the app is down/,
    );
  });

  it("drops the new slot and restarts the old one when cancelled after the new slot started", async () => {
    const { ctx } = context({ deployStrategy: "stop-first" });
    let checks = 0;
    ctx.checkAbort = () => {
      if (++checks > 1) throw new Error("Deployment aborted");
    };
    await expect(swap(ctx)).rejects.toThrow("Deployment aborted");
    const up = indexOf(isNewUp);
    const down = calls().findLastIndex(isNewDown);
    expect(down).toBeGreaterThan(up);
    expect(indexOf(isOldRestore)).toBeGreaterThan(down);
  });

  it("never applies to Vardo deploying itself", async () => {
    const { ctx } = context({ appName: "vardo", deployStrategy: "stop-first" });
    await swap(ctx);
    expect(indexOf((a) => a.includes("stop") && a.includes("vardo-production-blue"))).toBe(-1);
    expect(ctx.stopOldSlot).toBeTypeOf("function");
  });

  it("has nothing to stop on a first deploy, and says nothing about an old slot", async () => {
    const { ctx, logLines } = context({ deployStrategy: "stop-first", activeSlot: null });
    await swap(ctx);
    expect(indexOf((a) => a.includes("stop"))).toBe(-1);
    expect(logLines.join("\n")).not.toMatch(/old slot|Stop-first/);
  });
});

describe("swap — lock conflict hint", () => {
  it("suggests stop-first when the new slot hits a lock the live slot holds", async () => {
    state.greenState = "exited";
    state.greenLogs = LOCK_LINE;
    await expect(swap(context().ctx)).rejects.toThrow(
      /lock error while blue was still running on the same data \(\/mnt\/docker\/scrypted\/server\/volume\)[\s\S]*Set Deploy strategy to Stop first/,
    );
  });

  it("stays quiet when the crash has nothing to do with a lock", async () => {
    state.greenState = "exited";
    state.greenLogs = "scrypted-1  | Error: Cannot find module 'foo'";
    await expect(swap(context().ctx)).rejects.not.toThrow(/Stop first/);
  });

  it("stays quiet when the slots never overlapped", async () => {
    state.greenState = "exited";
    state.greenLogs = LOCK_LINE;
    await expect(swap(context({ deployStrategy: "stop-first" }).ctx)).rejects.not.toThrow(/Stop first/);
  });
});
