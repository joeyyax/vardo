// A compose build's phase time starts at the builder's admission, so time queued for the builder isn't counted as building.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      holdSlot: vi.fn(async () => ({ held: false, release: async () => {} })),
      NO_HOLD: { held: false, release: async () => {} },
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
vi.mock("@/lib/docker/compose-build", () => ({
  // Queued 60s for the builder, then builds for 10s.
  composeBuild: vi.fn(async (opts: { wait?: (reason: "build-slot" | null) => Promise<void> | void }) => {
    await opts.wait?.("build-slot");
    vi.setSystemTime(Date.now() + 60_000);
    await opts.wait?.(null);
    vi.setSystemTime(Date.now() + 10_000);
    return { stdout: "", stderr: "" };
  }),
}));
vi.mock("@/lib/docker/deploy-steps/bind-mount-ownership", () => ({
  prepareBindMountOwnership: vi.fn().mockResolvedValue(undefined),
  bindMountHostSource: vi.fn(),
  numericUid: vi.fn(),
}));

import { swap } from "@/lib/docker/deploy-steps/swap";
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { createStageTimings, formatTimings, timedWait } from "@/lib/docker/stage-timings";

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
  const timer = createStageTimings();
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
    timer,
    wait: timedWait(timer, () => {}),
    startTime: Date.now(),
  } as unknown as DeployContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-14T12:00:00Z"));
  getRegistryCredentials.mockResolvedValue({});
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("ps")) {
      return {
        stdout: JSON.stringify({ Service: "web", Name: "acme-production-green-web-1", State: "running", Health: "healthy" }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("swap — compose build timing", () => {
  it("records a build that waited 60s for the builder as its 10s of building, and the wait apart", async () => {
    const ctx = context();
    await swap(ctx);
    const timings = ctx.timer.snapshot();
    expect(timings.build?.ms).toBe(10_000);
    expect(timings.waitMs).toBe(60_000);
    expect(formatTimings(timings)).toContain("build 10.0s");
  });
});
