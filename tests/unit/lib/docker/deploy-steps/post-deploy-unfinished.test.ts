import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// postDeploy — work left undone behind a successful cutover
//
// The tail after the success row is where hooks run and the old slot stops. A
// failure there does not fail the deploy, but it must not vanish either: an
// old slot that never stopped is still holding its containers.
// ---------------------------------------------------------------------------

const { dbMock, writes, emitMock, execCalls, execFails, hooksMock, queueDrained } = vi.hoisted(() => {
  type Write = { table: unknown; values: Record<string, unknown> };
  const writes: Write[] = [];
  const execCalls: string[] = [];
  const execFails = { stop: false };
  const emitMock = vi.fn();
  const hooksMock = vi.fn().mockResolvedValue({ allowed: true });
  const queueDrained = vi.fn().mockResolvedValue(true);

  function makeUpdateChain(table: unknown) {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      writes.push({ table, values });
      return { where };
    });
    return { set };
  }

  const dbMock = {
    update: vi.fn().mockImplementation((table: unknown) => makeUpdateChain(table)),
    insert: vi.fn().mockReturnValue({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    query: {
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  };

  return { dbMock, writes, emitMock, execCalls, execFails, hooksMock, queueDrained };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: vi.fn().mockResolvedValue(false),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("1-0") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: emitMock }));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: hooksMock }));
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
  pruneBuildCache: vi.fn().mockResolvedValue({ spaceReclaimed: 0 }),
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
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
    const line = [cmd, ...args].join(" ");
    execCalls.push(line);
    if (execFails.stop && line.includes(" stop")) {
      cb(new Error("docker daemon unreachable"));
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  },
}));

import { postDeploy } from "@/lib/docker/deploy-steps/post-deploy";
import type { DeployContext } from "@/lib/docker/deploy-context";
import { deployments } from "@/lib/db/schema";

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

/** Reasons emitted on deploy.incomplete, in order. */
function unfinishedReasons(): string[] {
  return emitMock.mock.calls
    .map((call) => call[1] as { type: string; reason?: string })
    .filter((event) => event.type === "deploy.incomplete")
    .map((event) => event.reason ?? "");
}

describe("postDeploy tail work", () => {
  beforeEach(() => {
    writes.length = 0;
    execCalls.length = 0;
    execFails.stop = false;
    emitMock.mockClear();
    hooksMock.mockResolvedValue({ allowed: true });
    queueDrained.mockResolvedValue(true);
  });

  it("records nothing when the tail completes", async () => {
    await postDeploy(makeContext());

    expect(unfinishedReasons()).toEqual([]);
  });

  it("reports a deferred stop that failed — the old slot is still running", async () => {
    const stopOldSlot = vi.fn().mockRejectedValue(new Error("cutover guard timed out"));

    await postDeploy(makeContext({ activeSlot: "green", stopOldSlot }));

    expect(unfinishedReasons()[0]).toContain("still running");
    expect(unfinishedReasons()[0]).toContain("cutover guard timed out");
  });

  it("still stops the old slot when the queue check throws", async () => {
    queueDrained.mockRejectedValue(new Error("redis down"));
    const stopOldSlot = vi.fn().mockResolvedValue(undefined);

    await postDeploy(makeContext({ activeSlot: "green", stopOldSlot }));

    expect(stopOldSlot).toHaveBeenCalled();
    expect(unfinishedReasons()).toEqual([]);
  });

  it("reports an after.deploy.success hook that failed", async () => {
    hooksMock.mockResolvedValue({
      allowed: false,
      blockedBy: { hookName: "nightly-backup", reason: "webhook returned 500" },
    });

    await postDeploy(makeContext());

    expect(unfinishedReasons()[0]).toContain("nightly-backup");
    expect(unfinishedReasons()[0]).toContain("webhook returned 500");
  });

  it("reports an old slot that would not stop, once the deploy has committed", async () => {
    execFails.stop = true;

    const ctx = makeContext({ activeSlot: "green", isLocalEnv: false });
    await postDeploy(ctx);

    const success = writes.findIndex((w) => w.table === deployments && w.values.status === "success");
    const noted = writes.findIndex((w) => w.table === deployments && "postDeployError" in w.values);
    expect(unfinishedReasons()[0]).toContain("did not stop");
    expect(success).toBeGreaterThanOrEqual(0);
    expect(noted).toBeGreaterThan(success);
  });
});
