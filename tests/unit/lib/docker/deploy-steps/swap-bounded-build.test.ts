// ---------------------------------------------------------------------------
// A compose build runs in the BuildKit container, under its memory limit, and
// a build that runs out of memory fails with an error that says so.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  dbMock,
  execFileAsyncMock,
  execFileMock,
  restartPolicyMock,
  cutoverMock,
  inspectImageMeta,
  getRegistryCredentials,
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
    inspectImageMeta: vi.fn(async () => null),
    getRegistryCredentials: vi.fn(
      async () => ({}) as Record<string, { username: string; password: string }>,
    ),
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
vi.mock("@/lib/docker/image-updates/registry", () => ({ getRegistryCredentials }));
vi.mock("@/lib/docker/build-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/build-memory")>()),
  boundedBuild: vi.fn(async () => ({
    env: { BUILDX_BUILDER: "vardo-bounded", BUILDX_CONFIG: "/root/.docker/buildx" },
    loadArgs: ["--load"],
    limitBytes: 12 * 1024 ** 3,
  })),
}));
vi.mock("@/lib/docker/client", () => ({
  ensureNetwork: vi.fn().mockResolvedValue(undefined),
  inspectImageMeta,
}));
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

function composeFile(): ComposeFile {
  return {
    services: {
      web: {
        name: "web",
        image: "acme/web:local",
        build: { context: "." },
        labels: { "traefik.enable": "true" },
      },
    },
  } as unknown as ComposeFile;
}

function context(): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    organizationId: "org-1",
    app: {
      id: "app-1",
      name: "acme",
      displayName: "Acme",
      deployType: "compose",
      healthCheckTimeout: null,
      domains: [],
    },
    envName: "production",
    compose: composeFile(),
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/acme/production",
    slotDir: "/opt/vardo/apps/acme/production/green",
    newProjectName: "acme-production-green",
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
    stage: () => {},
    checkAbort: () => {},
    timer: createStageTimings(),
    startTime: Date.now(),
  } as unknown as DeployContext;
}

/** The options object each docker invocation was given. */
function optionsFor(command: string): Record<string, unknown> | undefined {
  const call = execFileAsyncMock.mock.calls.find((c) => (c[1] as string[]).includes(command));
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRegistryCredentials.mockResolvedValue({});
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({
          Service: "web",
          Name: "acme-production-green-web-1",
          State: "running",
          Health: "healthy",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("swap — bounded compose build", () => {
  it("runs the compose build on the bounded builder", async () => {
    await swap(context());

    const env = optionsFor("build")?.env as NodeJS.ProcessEnv;
    expect(env.BUILDX_BUILDER).toBe("vardo-bounded");
    expect(env.BUILDX_CONFIG).toBe("/root/.docker/buildx");
  });

  it("names the memory limit when the build runs out of memory", async () => {
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("build")) {
        throw new Error('failed to solve: ResourceExhausted: process "/bin/sh -c pnpm build" did not complete successfully: cannot allocate memory');
      }
      return { stdout: "", stderr: "" };
    });

    await expect(swap(context())).rejects.toThrow(/ran out of memory \(12 GiB\)/);
  });
});
