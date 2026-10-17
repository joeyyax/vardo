// A rotating service that binds host ports, published or on the host network,
// can't run in both slots, so the old slot stops before the new one starts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, headroomMock, cutoverMock, state } = vi.hoisted(() => {
  const state = { greenState: "running" };

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

const calls = () => execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
const indexOf = (match: (args: string[]) => boolean) => calls().findIndex(match);

const isOldStop = (a: string[]) => a.includes("stop") && a.includes("app-production-blue");
const isNewUp = (a: string[]) => a.includes("up") && a.includes("app-production-green");
const isOldRestore = (a: string[]) => a.includes("up") && a.includes("app-production-blue");

function context(scrypted: Record<string, unknown>) {
  const logLines: string[] = [];
  const ctx = {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: "app", displayName: "app", healthCheckTimeout: null, deployStrategy: "blue-green", domains: [] },
    envName: "production",
    compose: {
      services: { scrypted: { name: "scrypted", image: "ghcr.io/koush/scrypted", ...scrypted } },
    } as unknown as ComposeFile,
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/app/production",
    slotDir: "/opt/vardo/apps/app/production/green",
    newProjectName: "app-production-green",
    activeSlot: "blue",
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
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("logs")) return { stdout: "", stderr: "" };
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

describe("swap — host network", () => {
  it("stops the old slot before the new one starts", async () => {
    const { ctx } = context({ network_mode: "host" });
    await swap(ctx);
    const stop = indexOf(isOldStop);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(indexOf(isNewUp));
    expect(ctx.stopOldSlot).toBeUndefined();
  });

  it("says why, and never claims the old slot keeps serving", async () => {
    const { ctx, logLines } = context({ network_mode: "host" });
    await swap(ctx);
    const log = logLines.join("\n");
    expect(log).toContain("Host ports held by scrypted (host network) can't be bound twice — stopping blue before green starts. The app is down until green is healthy");
    expect(log).not.toMatch(/keeps serving/);
  });

  it("skips the memory check and the cutover pin", async () => {
    await swap(context({ network_mode: "host" }).ctx);
    expect(headroomMock.overlapFitsNow).not.toHaveBeenCalled();
    expect(cutoverMock.guardCutover).not.toHaveBeenCalled();
  });

  it("restarts the old slot when the new one fails its health check", async () => {
    state.greenState = "exited";
    await expect(swap(context({ network_mode: "host" }).ctx)).rejects.toThrow(/blue was restarted on the previous version/);
    expect(indexOf(isOldRestore)).toBeGreaterThan(indexOf(isNewUp));
  });
});

describe("swap — published host ports", () => {
  it("stops the old slot before the new one starts and says why", async () => {
    const { ctx, logLines } = context({ ports: ["11080:11080"] });
    await swap(ctx);
    expect(indexOf(isOldStop)).toBeLessThan(indexOf(isNewUp));
    expect(logLines.join("\n")).toContain("held by scrypted (published ports)");
  });
});

describe("swap — no host ports", () => {
  it("keeps the old slot serving until the new one is healthy", async () => {
    const { ctx, logLines } = context({});
    await swap(ctx);
    expect(indexOf(isOldStop)).toBe(-1);
    expect(ctx.stopOldSlot).toBeTypeOf("function");
    expect(logLines.join("\n")).toContain("No host ports bound — blue keeps serving until green is healthy");
  });

  it("treats network_mode none as overlap-safe", async () => {
    const { ctx } = context({ network_mode: "none" });
    await swap(ctx);
    expect(indexOf(isOldStop)).toBe(-1);
  });
});
