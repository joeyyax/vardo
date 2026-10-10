import { describe, it, expect, vi, beforeEach } from "vitest";

// #874: the first deploy that finds an app's volumes enrolls it in backups
// directly.

const backupDrain = vi.hoisted(() => ({
  drainBackupsForStop: vi.fn().mockResolvedValue([]),
  endBackupDrain: vi.fn(),
  backupDrainTimeoutMs: () => 20 * 60_000,
}));

const { dbMock, writes, emitMock, execCalls, execFails, queueDrained, drainMock, endDrainMock, enrollNewApp, enrollNewVolumes } = vi.hoisted(() => {
  const drainMock = vi.fn().mockResolvedValue([]);
  const endDrainMock = vi.fn();
  type Write = { table: unknown; values: Record<string, unknown> };
  const writes: Write[] = [];
  const execCalls: string[] = [];
  const execFails = { stop: false };
  const emitMock = vi.fn();
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
      backupJobApps: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };

  return {
    dbMock, writes, emitMock, execCalls, execFails, queueDrained, drainMock, endDrainMock,
    enrollNewApp: vi.fn().mockResolvedValue({ status: "covered", jobId: "job-1" }),
    enrollNewVolumes: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/backups/enroll", () => ({ enrollNewApp, enrollNewVolumes }));
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
vi.mock("@/lib/cron/engine", () => ({ syncCronJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/docker/deploy", () => ({
  checkEndpoint: vi.fn().mockResolvedValue(true),
  sendDeployNotification: vi.fn().mockResolvedValue(undefined),
  recordSelfUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({
  listContainers: vi.fn().mockResolvedValue([]),
  inspectContainer: vi.fn().mockResolvedValue({ state: { status: "running" }, mounts: [] }),
  removeContainer: vi.fn().mockResolvedValue(undefined),
  stripDockerProjectPrefix: (name: string) => name,
  volumeNameFromMount: (m: { name: string }) => m.name,
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
vi.mock("@/lib/docker/deploy-cancel", () => ({
  drainForSelfStop: drainMock,
  endSelfDrain: endDrainMock,
  SELF_DRAIN_TIMEOUT_MS: 15 * 60_000,
}));
vi.mock("@/lib/backups/in-flight", () => backupDrain);
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
import { listContainers, inspectContainer } from "@/lib/docker/client";

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


const namedMount = {
  type: "volume",
  name: "notes_data",
  source: "/var/lib/docker/volumes/notes_data/_data",
  destination: "/data",
};

describe("postDeploy backup enrollment", () => {
  beforeEach(() => {
    enrollNewApp.mockClear();
    enrollNewVolumes.mockClear();
    vi.mocked(listContainers).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(inspectContainer).mockResolvedValue({
      state: { status: "running" },
      image: "notes:latest",
      labels: { "com.docker.compose.service": "web" },
      mounts: [namedMount],
    } as never);
  });

  it("enrolls an app on the deploy that first finds its volumes", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([]);

    await postDeploy(makeContext());

    expect(enrollNewApp).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: "org-1", measure: true }),
    );
  });

  it("says so when the app's backup switch is off", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([]);
    enrollNewApp.mockResolvedValueOnce({ status: "off" });
    const ctx = makeContext();

    await postDeploy(ctx);

    expect(ctx.logLines).toContain("[deploy] Backups: off for this app");
  });

  it("hands volumes found later to the existing job only", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "old", appId: "app-1", mountPath: "/config", type: "bind", source: "/mnt/docker/app/config" },
    ]);

    await postDeploy(makeContext());

    expect(enrollNewApp).not.toHaveBeenCalled();
    expect(enrollNewVolumes).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1", covered: false }));
  });

  it("clears the selection of a mount whose source changed", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "old", appId: "app-1", mountPath: "/data", type: "bind", source: "/mnt/docker/app/data", backupSelection: "include" },
    ]);

    await postDeploy(makeContext());

    expect(writes.map((w) => w.values)).toContainEqual(
      expect.objectContaining({ type: "named", backupSelection: null }),
    );
    expect(enrollNewVolumes).toHaveBeenCalledWith(expect.objectContaining({ volumeIds: ["old"] }));
  });

  it("classifies a pre-inserted database row as a dump", async () => {
    writes.length = 0;
    vi.mocked(inspectContainer).mockResolvedValue({
      state: { status: "running" },
      image: "postgres:16",
      labels: { "com.docker.compose.service": "db" },
      mounts: [{ type: "volume", name: "pgdata", source: "/var/lib/docker/volumes/pgdata/_data", destination: "/var/lib/postgresql/data" }],
    } as never);
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "pg", appId: "app-1", name: "pgdata", mountPath: "/var/lib/postgresql/data", type: "named", source: null, durability: null, backupStrategy: "tar", backupSpec: null },
    ]);

    await postDeploy(makeContext());

    expect(writes.map((w) => w.values)).toContainEqual(
      expect.objectContaining({ durability: "stateful", backupStrategy: "dump", backupSpec: { kind: "postgres", service: "db" } }),
    );
    expect(enrollNewVolumes).toHaveBeenCalledWith(expect.objectContaining({ volumeIds: ["pg"] }));
  });

  it("leaves a row the operator already classified", async () => {
    writes.length = 0;
    vi.mocked(inspectContainer).mockResolvedValue({
      state: { status: "running" },
      image: "postgres:16",
      labels: { "com.docker.compose.service": "db" },
      mounts: [{ type: "volume", name: "pgdata", source: "/var/lib/docker/volumes/pgdata/_data", destination: "/var/lib/postgresql/data" }],
    } as never);
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "pg", appId: "app-1", name: "pgdata", mountPath: "/var/lib/postgresql/data", type: "named", source: null, durability: "external", backupStrategy: "tar", backupSpec: null },
    ]);

    await postDeploy(makeContext());

    expect(writes.map((w) => w.values)).not.toContainEqual(expect.objectContaining({ backupStrategy: "dump" }));
  });

  it("enrolls an app whose named volume prepare-repo inserted this deploy", async () => {
    const startTime = Date.now() - 1000;
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "nv", appId: "app-1", name: "notes_data", mountPath: "/data", type: "named", source: null, durability: null, backupSpec: null, createdAt: new Date() },
    ]);

    await postDeploy(makeContext({ startTime }));

    expect(enrollNewApp).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1", measure: true }));
  });

  it("does not re-enroll on a redeploy", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([
      { id: "nv", appId: "app-1", name: "notes_data", mountPath: "/data", type: "named", source: null, durability: null, backupSpec: null, backupSelection: "include", createdAt: new Date(Date.now() - 86_400_000) },
    ]);

    await postDeploy(makeContext());

    expect(enrollNewApp).not.toHaveBeenCalled();
    expect(enrollNewVolumes).not.toHaveBeenCalled();
  });
});

describe("postDeploy volume reconcile", () => {
  const oldRow = (id: string, name: string, mountPath: string) => ({
    id, appId: "app-1", name, mountPath, type: "named", source: null, removedAt: null,
    durability: null, backupStrategy: "tar", backupSpec: null, backupSelection: "include",
    createdAt: new Date(Date.now() - 86_400_000),
  });
  const container = (id: string, project: string, mounts: unknown[]) => ({
    state: { status: "running" },
    image: "app:latest",
    labels: { "com.docker.compose.service": "web", "com.docker.compose.project": project },
    mounts,
    id,
  });

  beforeEach(() => {
    writes.length = 0;
    enrollNewVolumes.mockClear();
  });

  it("switches rows to bind mounts when the compose moves named volumes to host paths", async () => {
    const green = container("old", "app-production-green", [
      { type: "volume", name: "app-production_config", source: "", destination: "/config" },
      { type: "volume", name: "app-production_data", source: "", destination: "/data" },
    ]);
    const blue = container("new", "app-production-blue", [
      { type: "bind", name: "", source: "/srv/app-data/config", destination: "/config" },
      { type: "bind", name: "", source: "/srv/app-data/data", destination: "/data" },
    ]);
    // The old slot is listed first and still running.
    vi.mocked(listContainers).mockResolvedValue([
      { id: "old", labels: green.labels },
      { id: "new", labels: blue.labels },
    ] as never);
    vi.mocked(inspectContainer).mockImplementation(async (id: string) => (id === "old" ? green : blue) as never);
    dbMock.query.volumes.findMany.mockResolvedValue([oldRow("v1", "config", "/config"), oldRow("v2", "data", "/data")]);
    const ctx = makeContext({
      isLocalEnv: false,
      compose: {
        services: { web: { name: "web", volumes: ["/srv/app-data/config:/config", "/srv/app-data/data:/data"] } },
      },
    });

    await postDeploy(ctx);

    expect(writes.map((w) => w.values)).toContainEqual(
      expect.objectContaining({ type: "bind", source: "/srv/app-data/config", persistent: false, backupSelection: null }),
    );
    expect(writes.map((w) => w.values)).toContainEqual(
      expect.objectContaining({ type: "bind", source: "/srv/app-data/data", persistent: false, backupSelection: null }),
    );
    expect(writes.some((w) => w.values.removedAt instanceof Date)).toBe(false);
    const note = ctx.logLines.filter((l) => l.startsWith("[deploy] Volume records updated"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("/config now mounts /srv/app-data/config");
    expect(enrollNewVolumes).toHaveBeenCalledWith(expect.objectContaining({ volumeIds: ["v1", "v2"] }));
  });

  it("marks a row removed when the compose drops its volume", async () => {
    const blue = container("new", "app-production-blue", [
      { type: "volume", name: "app-production_data", source: "", destination: "/data" },
    ]);
    vi.mocked(listContainers).mockResolvedValue([{ id: "new", labels: blue.labels }] as never);
    vi.mocked(inspectContainer).mockResolvedValue(blue as never);
    dbMock.query.volumes.findMany.mockResolvedValue([oldRow("v1", "data", "/data"), oldRow("v2", "cache", "/cache")]);
    const ctx = makeContext({
      compose: { services: { web: { name: "web", volumes: ["data:/data"] } }, volumes: { data: {} } },
    });

    await postDeploy(ctx);

    const removed = writes.filter((w) => w.values.removedAt instanceof Date);
    expect(removed).toHaveLength(1);
    expect(ctx.logLines).toContain(
      "[deploy] Volume records updated: no longer declared: cache (/cache) — backups skip them",
    );
  });

  it("removes nothing when a container of the new slot can't be inspected", async () => {
    vi.mocked(listContainers).mockResolvedValue([{ id: "new", labels: {} }] as never);
    vi.mocked(inspectContainer).mockRejectedValue(new Error("gone"));
    dbMock.query.volumes.findMany.mockResolvedValue([oldRow("v2", "cache", "/cache")]);

    await postDeploy(makeContext({ compose: { services: { web: { name: "web" } } } }));

    expect(writes.some((w) => w.values.removedAt instanceof Date)).toBe(false);
  });
});

describe("postDeploy dump classification for Uptime Kuma", () => {
  const kumaMount = {
    type: "volume",
    name: "kuma_data",
    source: "/var/lib/docker/volumes/kuma_data/_data",
    destination: "/app/data",
  };
  const row = (createdAt: Date) => ({
    id: "kv", appId: "app-1", name: "kuma_data", mountPath: "/app/data", type: "named", source: null,
    durability: null, backupStrategy: "tar", backupSpec: null, createdAt,
  });

  beforeEach(() => {
    writes.length = 0;
    vi.mocked(listContainers).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(inspectContainer).mockResolvedValue({
      state: { status: "running" },
      image: "louislam/uptime-kuma:2",
      labels: { "com.docker.compose.service": "uptime-kuma" },
      mounts: [kumaMount],
    } as never);
  });

  it("switches a volume found this deploy to a dump", async () => {
    const startTime = Date.now() - 1000;
    dbMock.query.volumes.findMany.mockResolvedValue([row(new Date())]);

    await postDeploy(makeContext({ startTime }));

    expect(writes.map((w) => w.values)).toContainEqual(
      expect.objectContaining({ backupStrategy: "dump", backupSpec: { kind: "uptime-kuma", service: "uptime-kuma" } }),
    );
  });

  it("leaves an existing volume on its file archive", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([row(new Date(Date.now() - 86_400_000))]);

    await postDeploy(makeContext());

    expect(writes.map((w) => w.values)).not.toContainEqual(expect.objectContaining({ backupStrategy: "dump" }));
  });
});
