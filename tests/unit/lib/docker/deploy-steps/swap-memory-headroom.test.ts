// ---------------------------------------------------------------------------
// A cutover with no room for both slots degrades to the stop-then-start order a
// published host port already forces, rather than refusing to deploy.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, headroomMock, cutoverMock, oomMock, order } =
  vi.hoisted(() => {
    const order: string[] = [];

    const dbMock = {
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
    };

    const execFileAsyncMock = vi.fn();
    const execFileMock = vi.fn();
    Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
      value: execFileAsyncMock,
      configurable: true,
      writable: true,
    });

    return {
      order,
      dbMock,
      execFileAsyncMock,
      execFileMock,
      headroomMock: { overlapFitsNow: vi.fn(async () => true) },
      oomMock: { reportOomDuringDeploy: vi.fn(async () => {}) },
      cutoverMock: {
        clearCutoverPin: vi.fn(async () => {}),
        guardCutover: vi.fn(async () => {
          order.push("pin");
          return { pinned: true, release: async () => { order.push("unpin"); } };
        }),
      },
    };
  });

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/memory-headroom", () => headroomMock);
vi.mock("@/lib/docker/deploy-oom", () => oomMock);
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn(async () => {}),
  restoreSlotRestart: vi.fn(async () => {}),
}));
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

/** Index of the first docker call matching a predicate, or -1. */
function indexOf(match: (args: string[]) => boolean): number {
  return execFileAsyncMock.mock.calls.findIndex((c) => match(c[1] as string[]));
}

const isOldSlotStop = (a: string[]) => a.includes("stop") && a.includes("app-production-blue");
const isNewSlotUp = (a: string[]) => a.includes("up") && a.includes("app-production-green");

function context(overrides: { appName?: string } = {}): DeployContext {
  const logLines: string[] = [];
  const appName = overrides.appName ?? "app";
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: appName, displayName: appName, healthCheckTimeout: null, domains: [] },
    envName: "production",
    compose: {
      services: { web: { name: "web", image: "nginx", labels: { "traefik.enable": "true" } } },
    } as unknown as ComposeFile,
    builtImageRefs: [],
    appDir: `/opt/vardo/apps/${appName}/production`,
    slotDir: `/opt/vardo/apps/${appName}/production/green`,
    newProjectName: `${appName}-production-green`,
    activeSlot: "blue",
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => { logLines.push(line); return line; },
    stage: () => {},
    checkAbort: () => {},
    startTime: Date.now(),
  } as unknown as DeployContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  headroomMock.overlapFitsNow.mockResolvedValue(true);
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "healthy" }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — memory headroom", () => {
  it("keeps the old slot serving when both fit", async () => {
    await swap(context());
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });

  it("stops the old slot before the new one when they do not", async () => {
    headroomMock.overlapFitsNow.mockResolvedValue(false);
    await swap(context());
    expect(indexOf(isOldSlotStop)).toBeLessThan(indexOf(isNewSlotUp));
  });

  it("does not pin traffic to a slot that is not up yet", async () => {
    headroomMock.overlapFitsNow.mockResolvedValue(false);
    await swap(context());
    expect(cutoverMock.guardCutover).not.toHaveBeenCalled();
  });

  it("stops the old slot once, not again after the health check", async () => {
    headroomMock.overlapFitsNow.mockResolvedValue(false);
    await swap(context());
    expect(execFileAsyncMock.mock.calls.filter((c) => isOldSlotStop(c[1] as string[]))).toHaveLength(1);
  });

  it("never degrades Vardo deploying itself — its old slot runs the deploy", async () => {
    const ctx = context({ appName: "vardo" });
    await swap(ctx);
    expect(headroomMock.overlapFitsNow).not.toHaveBeenCalled();
    expect(ctx.stopOldSlot).toBeTypeOf("function");
  });

  it("skips the check on a first deploy, where there is no old slot", async () => {
    const ctx = { ...context(), activeSlot: null } as DeployContext;
    await swap(ctx);
    expect(headroomMock.overlapFitsNow).not.toHaveBeenCalled();
  });
});

describe("swap — OOM inside the deploy window", () => {
  it("checks the old slot after stopping it", async () => {
    await swap(context());
    expect(oomMock.reportOomDuringDeploy).toHaveBeenCalledWith(
      { organizationId: "org-1", appId: "app-1", appName: "app" },
      "app-production-blue",
      expect.any(Date),
      expect.any(Function),
    );
  });

  it("checks it on the stop-first path too", async () => {
    headroomMock.overlapFitsNow.mockResolvedValue(false);
    await swap(context());
    expect(oomMock.reportOomDuringDeploy).toHaveBeenCalledOnce();
  });

  it("checks nothing on a first deploy", async () => {
    await swap({ ...context(), activeSlot: null } as DeployContext);
    expect(oomMock.reportOomDuringDeploy).not.toHaveBeenCalled();
  });
});
