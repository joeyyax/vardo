// ---------------------------------------------------------------------------
// A named volume is externalized to a name carrying no slot, so an overlap
// would run two containers against one directory. The swap degrades to the
// stop-then-start order a published host port already forces.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, headroomMock, cutoverMock } = vi.hoisted(() => {
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
    dbMock,
    execFileAsyncMock,
    execFileMock,
    headroomMock: { overlapFitsNow: vi.fn(async () => true) },
    cutoverMock: {
      clearCutoverPin: vi.fn(async () => {}),
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

function indexOf(match: (args: string[]) => boolean): number {
  return execFileAsyncMock.mock.calls.findIndex((c) => match(c[1] as string[]));
}

const isOldSlotStop = (a: string[]) => a.includes("stop") && a.some((x) => x.endsWith("-production-blue"));
const isNewSlotUp = (a: string[]) => a.includes("up") && a.some((x) => x.endsWith("-production-green"));

const web = { name: "web", image: "example/web:1", labels: { "traefik.enable": "true" } };

/** Nothing outlives a slot — the shape that keeps both slots up. */
function stateless(): ComposeFile {
  return { services: { web } } as unknown as ComposeFile;
}

/** A rotating service on a top-level named volume. */
function statefulSlotted(): ComposeFile {
  return {
    services: {
      web,
      queue: { name: "queue", image: "example/queue:1", volumes: ["queue-data:/var/lib/queue"] },
    },
    volumes: { "queue-data": {} },
  } as unknown as ComposeFile;
}

function context(overrides: { compose?: ComposeFile; appName?: string } = {}): DeployContext {
  const logLines: string[] = [];
  const appName = overrides.appName ?? "app";
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: { id: "app-1", name: appName, displayName: appName, healthCheckTimeout: null, domains: [] },
    envName: "production",
    compose: overrides.compose ?? stateless(),
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
  headroomMock.overlapFitsNow.mockResolvedValue(true);
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    // The old slot holds nothing the shared project is about to claim.
    if (args.includes("ps") && args.includes("-q")) return { stdout: "", stderr: "" };
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "healthy" }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — a rotating service on an externalized volume", () => {
  it("stops the old slot before the new one starts", async () => {
    await swap(context({ compose: statefulSlotted() }));
    expect(indexOf(isOldSlotStop)).toBeLessThan(indexOf(isNewSlotUp));
  });

  it("names the service that forced the order", async () => {
    const ctx = context({ compose: statefulSlotted() });
    await swap(ctx);
    expect(ctx.logLines).toContainEqual(
      "[deploy] Volume both slots would hold, mounted by queue — stopping blue before green starts",
    );
  });

  it("does not pin traffic to a slot that is not up yet", async () => {
    await swap(context({ compose: statefulSlotted() }));
    expect(cutoverMock.guardCutover).not.toHaveBeenCalled();
  });

  it("skips the memory probe once the order is already decided", async () => {
    await swap(context({ compose: statefulSlotted() }));
    expect(headroomMock.overlapFitsNow).not.toHaveBeenCalled();
  });

  it("keeps both slots up when nothing outlives a slot", async () => {
    await swap(context());
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });

  it("keeps both slots up when the volume belongs to a shared service", async () => {
    const compose = {
      services: {
        web,
        postgres: {
          name: "postgres",
          image: "postgres:17",
          volumes: ["postgres-data:/var/lib/postgresql/data"],
        },
      },
      volumes: { "postgres-data": {} },
    } as unknown as ComposeFile;

    await swap(context({ compose }));
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });

  it("keeps both slots up for a bind mount, which no slot externalizes", async () => {
    const compose = {
      services: {
        web,
        queue: { name: "queue", image: "example/queue:1", volumes: ["./data:/var/lib/queue"] },
      },
    } as unknown as ComposeFile;

    await swap(context({ compose }));
    expect(indexOf(isOldSlotStop)).toBeGreaterThan(indexOf(isNewSlotUp));
  });

  it("never degrades Vardo deploying itself — its old slot runs the deploy", async () => {
    const ctx = context({ compose: statefulSlotted(), appName: "vardo" });
    await swap(ctx);
    expect(indexOf(isOldSlotStop)).toBe(-1);
    expect(ctx.stopOldSlot).toBeTypeOf("function");
  });
});
