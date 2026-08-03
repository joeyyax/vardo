// ---------------------------------------------------------------------------
// Where the major gate sits in the swap.
//
// It has to stop the deploy between the pre-pull and the old slot's stop. A
// block after that point would leave the app down with no container that can
// start, which is the outage the gate exists to avoid.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  dbMock,
  execFileAsyncMock,
  execFileMock,
  restartPolicyMock,
  cutoverMock,
  inspectImageMeta,
  writeMajorGateBlock,
} = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return {
    execFileAsyncMock,
    execFileMock,
    inspectImageMeta: vi.fn(),
    writeMajorGateBlock: vi.fn(async () => {}),
    dbMock: {
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      query: { deployments: { findFirst: vi.fn(async () => undefined) } },
    },
    restartPolicyMock: {
      demoteStandbyRestart: vi.fn(async () => {}),
      restoreSlotRestart: vi.fn(async () => {}),
    },
    cutoverMock: {
      clearCutoverPin: vi.fn(async () => {}),
      guardCutover: vi.fn(async () => ({ pinned: true, release: async () => {} })),
    },
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/restart-policy", () => restartPolicyMock);
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/client", () => ({
  ensureNetwork: vi.fn().mockResolvedValue(undefined),
  inspectImageMeta,
}));
vi.mock("@/lib/docker/image-updates/major-gate-store", () => ({ writeMajorGateBlock }));
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
import { DeployBlockedError } from "@/lib/docker/errors";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";

function pgEnv(major: number): string[] {
  return ["GOSU_VERSION=1.19", `PG_MAJOR=${major}`, `PG_VERSION=${major}.4-1.pgdg13+1`];
}

/** A published host port, so a swap that gets past the gate must stop first. */
function composeFile(): ComposeFile {
  return {
    services: {
      web: {
        name: "web",
        image: "nginx:1.27",
        ports: ["8080:80"],
        labels: { "traefik.enable": "true" },
      },
      db: { name: "db", image: "postgres:latest" },
    },
  } as unknown as ComposeFile;
}

const stages: [string, string][] = [];

function context(): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: {
      id: "app-1",
      name: "outline",
      displayName: "Outline",
      deployType: "compose",
      healthCheckTimeout: null,
      domains: [],
    },
    envName: "production",
    compose: composeFile(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/outline/production",
    slotDir: "/opt/vardo/apps/outline/production/green",
    newProjectName: "outline-production-green",
    activeSlot: "blue",
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: ["-f", "docker-compose.yml"],
    logLines,
    logs: { push: (line: string) => logLines.push(line) },
    log: (line: string) => {
      logLines.push(line);
      return line;
    },
    stage: (stage: string, status: string) => stages.push([stage, status]),
    checkAbort: () => {},
    startTime: Date.now(),
  } as unknown as DeployContext;
}

function argv(): string[][] {
  return execFileAsyncMock.mock.calls.map((c) => c[1] as string[]);
}

const touchesOldSlot = (a: string[]) => a.includes("outline-production-blue");
const startsNewSlot = (a: string[]) => a.includes("up");

beforeEach(() => {
  vi.clearAllMocks();
  stages.length = 0;
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({
          Service: "web",
          Name: "outline-production-green-web-1",
          State: "running",
          Health: "healthy",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — major gate", () => {
  it("stops the deploy without touching the old slot", async () => {
    inspectImageMeta
      .mockResolvedValueOnce({ id: "sha256:a", env: pgEnv(16), labels: {} })
      .mockResolvedValueOnce({ id: "sha256:b", env: pgEnv(18), labels: {} });

    await expect(swap(context())).rejects.toBeInstanceOf(DeployBlockedError);

    expect(argv().some(touchesOldSlot)).toBe(false);
    expect(argv().some(startsNewSlot)).toBe(false);
    expect(restartPolicyMock.demoteStandbyRestart).not.toHaveBeenCalled();
  });

  it("blocks before the stage that says containers are running", async () => {
    inspectImageMeta
      .mockResolvedValueOnce({ id: "sha256:a", env: pgEnv(16), labels: {} })
      .mockResolvedValueOnce({ id: "sha256:b", env: pgEnv(18), labels: {} });

    await expect(swap(context())).rejects.toBeInstanceOf(DeployBlockedError);

    // runDeployment tears down and marks the app errored per stage; anything at
    // or past "deploy" would mean the app was left mid-swap.
    expect(stages.map(([stage]) => stage)).not.toContain("deploy");
    expect(stages).not.toContainEqual(["build", "success"]);
  });

  it("records the block for the app's updates panel", async () => {
    inspectImageMeta
      .mockResolvedValueOnce({ id: "sha256:a", env: pgEnv(16), labels: {} })
      .mockResolvedValueOnce({ id: "sha256:b", env: pgEnv(18), labels: {} });

    await expect(swap(context())).rejects.toThrow(/still serving/);

    expect(writeMajorGateBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "app-1",
        appName: "Outline",
        services: [expect.objectContaining({ service: "db", from: 16, to: 18 })],
      }),
    );
  });

  it("swaps as usual when the major held", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: pgEnv(17), labels: {} });

    await swap(context());

    expect(argv().some(startsNewSlot)).toBe(true);
    expect(writeMajorGateBlock).not.toHaveBeenCalled();
  });
});
