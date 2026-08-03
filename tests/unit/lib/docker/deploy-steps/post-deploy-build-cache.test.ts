import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// postDeploy — bounding the build cache
//
// The prune this step runs used to filter on `until: 168h`, which reclaims
// nothing on a host that deploys several times a day: no record is ever a week
// past its last use before the next deploy piles more on top. Vardo's own cache
// reached 18.75 GB in a day that way, across eight self-deploys and eight
// prunes that each freed nothing. The ceiling replaces the window, so what the
// prune is asked for must stay a size and must stay unfiltered.
// ---------------------------------------------------------------------------

const { dbMock, emitMock, pruneBuildCacheMock, queueDrained, lockAcquired } = vi.hoisted(() => {
  const emitMock = vi.fn();
  const pruneBuildCacheMock = vi.fn().mockResolvedValue({ spaceReclaimed: 0 });
  const queueDrained = vi.fn().mockResolvedValue(true);
  const lockAcquired = vi.fn().mockResolvedValue(true);

  const dbMock = {
    update: vi.fn().mockImplementation(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn().mockReturnValue({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    query: {
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  };

  return { dbMock, emitMock, pruneBuildCacheMock, queueDrained, lockAcquired };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: lockAcquired,
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("1-0") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: emitMock }));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/cron/engine", () => ({ syncCronJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/docker/deploy", () => ({
  checkEndpoint: vi.fn().mockResolvedValue(true),
  sendDeployNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({
  listContainers: vi.fn().mockResolvedValue([]),
  inspectContainer: vi.fn().mockResolvedValue({ state: { status: "running" }, mounts: [] }),
  removeContainer: vi.fn().mockResolvedValue(undefined),
  stripDockerProjectPrefix: (name: string) => name,
  listImages: vi.fn().mockResolvedValue([]),
  inspectImageDigest: vi.fn().mockResolvedValue(null),
  removeImage: vi.fn().mockResolvedValue(undefined),
  pruneImages: vi.fn().mockResolvedValue({ spaceReclaimed: 0, count: 0 }),
  pruneBuildCache: pruneBuildCacheMock,
}));
vi.mock("@/lib/docker/compose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/compose")>()),
  slotComposeFiles: vi.fn(async () => ["-f", "docker-compose.yml"]),
}));
vi.mock("@/lib/docker/compose-sync", () => ({ syncComposeServices: vi.fn() }));
vi.mock("@/lib/docker/deploy-steps/major-gate", () => ({ observedMajors: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/docker/image-updates/major-gate-store", () => ({
  clearMajorGateBlock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/restart-policy", () => ({ demoteStandbyRestart: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  isDeployQueueDrained: queueDrained,
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
    cb(null, { stdout: "", stderr: "" });
  },
}));

import { postDeploy } from "@/lib/docker/deploy-steps/post-deploy";
import type { DeployContext } from "@/lib/docker/deploy-context";
import { BUILD_CACHE_MAX_BYTES } from "@/lib/docker/constants";
import { formatBytes } from "@/lib/metrics/format";

function makeContext(overrides: Partial<DeployContext> = {}): DeployContext {
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    return line;
  };
  return {
    deploymentId: "dep-1",
    appId: "app-1",
    organizationId: "org-1",
    trigger: "api",
    app: {
      id: "app-1",
      name: "app",
      displayName: "App",
      organizationId: "org-1",
      deployType: "compose",
      domains: [],
      envContent: null,
      importedContainerId: null,
      templateName: null,
      autoRollback: false,
    } as unknown as DeployContext["app"],
    org: null,
    orgTrusted: false,
    projectAllowBindMounts: false,
    projectAllowDockerSocket: false,
    envName: "production",
    envType: "production",
    envBranchOverride: null,
    envMap: {},
    volumesList: [],
    appVolumes: [],
    effectiveSource: "git",
    compose: { services: {} },
    bareCompose: { services: {} },
    serviceConfig: {},
    builtLocally: false,
    builtImageRefs: [],
    hostConfig: null,
    repoDir: null,
    appBase: "/tmp/vardo-test/app",
    appDir: "/tmp/vardo-test/app/production",
    slotDir: "/tmp/vardo-test/app/production/blue",
    newProjectName: "app-production-blue",
    activeSlot: null,
    newSlot: "blue",
    isLocalEnv: true,
    containerPort: 3000,
    composeFileArgs: [],
    stableVolumePrefix: "",
    log,
    stage: vi.fn(),
    checkAbort: vi.fn(),
    logs: { push: log },
    logLines,
    startTime: Date.now(),
    ...overrides,
  } as DeployContext;
}

describe("post-deploy build cache prune", () => {
  beforeEach(() => {
    pruneBuildCacheMock.mockClear();
    pruneBuildCacheMock.mockResolvedValue({ spaceReclaimed: 0 });
    queueDrained.mockResolvedValue(true);
    lockAcquired.mockResolvedValue(true);
  });

  it("asks for a byte ceiling and no age filter", async () => {
    await postDeploy(makeContext());

    expect(pruneBuildCacheMock).toHaveBeenCalledWith(undefined, {
      keepStorage: BUILD_CACHE_MAX_BYTES,
    });
  });

  it("has a ceiling large enough to hold a build", async () => {
    expect(BUILD_CACHE_MAX_BYTES).toBeGreaterThanOrEqual(4 * 1024 ** 3);
  });

  it("names the ceiling in the deploy log when it reclaims", async () => {
    pruneBuildCacheMock.mockResolvedValue({ spaceReclaimed: 3 * 1024 ** 3 });
    const ctx = makeContext();

    await postDeploy(ctx);

    const line = ctx.logLines.find((l) => l.includes("Build cache over"));
    expect(line).toContain(formatBytes(BUILD_CACHE_MAX_BYTES));
    expect(line).toContain(formatBytes(3 * 1024 ** 3));
  });

  it("says nothing when the cache is already under the ceiling", async () => {
    const ctx = makeContext();

    await postDeploy(ctx);

    expect(ctx.logLines.some((l) => l.includes("Build cache"))).toBe(false);
  });

  it("still defers to a deploy already in flight", async () => {
    queueDrained.mockResolvedValue(false);

    await postDeploy(makeContext());

    expect(pruneBuildCacheMock).not.toHaveBeenCalled();
  });
});
