import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// postDeploy — work left undone behind a successful cutover
//
// The tail after the success row is where hooks run and the old slot stops. A
// failure there does not fail the deploy, but it must not vanish either: an
// old slot that never stopped is still holding its containers.
// ---------------------------------------------------------------------------

const { dbMock, writes, emitMock, execCalls, execFails, hooksMock, queueDrained, commitFails, drainMock, endDrainMock } = vi.hoisted(() => {
  const drainMock = vi.fn().mockResolvedValue([]);
  const endDrainMock = vi.fn();
  type Write = { table: unknown; values: Record<string, unknown> };
  const writes: Write[] = [];
  const execCalls: string[] = [];
  const execFails = { stop: false };
  const emitMock = vi.fn();
  const hooksMock = vi.fn().mockResolvedValue({ allowed: true });
  const queueDrained = vi.fn().mockResolvedValue(true);
  const commitFails = { value: false };

  function makeUpdateChain(table: unknown) {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      if (commitFails.value && values.status === "success") throw new Error("connection terminated");
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

  return { dbMock, writes, emitMock, execCalls, execFails, hooksMock, queueDrained, commitFails, drainMock, endDrainMock };
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
vi.mock("@/lib/docker/deploy-cancel", () => ({
  drainForSelfStop: drainMock,
  endSelfDrain: endDrainMock,
  SELF_DRAIN_TIMEOUT_MS: 15 * 60_000,
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
import { deployments, apps } from "@/lib/db/schema";
import { syncComposeServices } from "@/lib/docker/compose-sync";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { sendDeployNotification } from "@/lib/docker/deploy";
import { removeContainer, inspectContainer } from "@/lib/docker/client";

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
    commitFails.value = false;
    vi.mocked(removeContainer).mockClear();
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

  it("reports a deferred stop that came back as failed", async () => {
    const stopOldSlot = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "docker daemon unreachable" });

    await postDeploy(makeContext({ activeSlot: "green", stopOldSlot }));

    expect(unfinishedReasons()[0]).toContain("still running");
    expect(unfinishedReasons()[0]).toContain("docker daemon unreachable");
  });

  it("carries a stop the swap could not finish onto the row, behind the success", async () => {
    const ctx = makeContext({
      unfinished: ["the old slot (green) is still running — docker daemon unreachable"],
    });

    await postDeploy(ctx);

    const success = writes.findIndex((w) => w.table === deployments && w.values.status === "success");
    const noted = writes.findIndex((w) => w.table === deployments && "postDeployError" in w.values);
    expect(unfinishedReasons()[0]).toContain("still running");
    expect(noted).toBeGreaterThan(success);
  });

  it("stays silent when the tail's announcements fail", async () => {
    vi.mocked(addEvent).mockRejectedValueOnce(new Error("redis down"));
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("insert failed"));
    vi.mocked(sendDeployNotification).mockRejectedValueOnce(new Error("smtp unreachable"));

    await expect(postDeploy(makeContext())).resolves.toBeTruthy();

    expect(unfinishedReasons()).toEqual([]);
  });

  it("still stops the old slot when the queue check throws", async () => {
    queueDrained.mockRejectedValue(new Error("redis down"));
    const stopOldSlot = vi.fn().mockResolvedValue({ ok: true });

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

  it("stops the old slot only after the deploy commits", async () => {
    let committedFirst = false;
    const stopOldSlot = vi.fn(async () => {
      committedFirst = writes.some((w) => w.table === deployments && w.values.status === "success");
      return { ok: true as const };
    });

    await postDeploy(makeContext({ activeSlot: "green", isLocalEnv: false, stopOldSlot }));

    expect(stopOldSlot).toHaveBeenCalledOnce();
    expect(committedFirst).toBe(true);
  });

  it("leaves the old slot and the imported original alone when the commit fails", async () => {
    commitFails.value = true;
    const stopOldSlot = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeContext({
      activeSlot: "green",
      isLocalEnv: false,
      stopOldSlot,
      app: { ...makeContext().app, importedContainerId: "abc123" },
    });

    await expect(postDeploy(ctx)).rejects.toThrow("connection terminated");

    expect(ctx.succeeded).toBeFalsy();
    expect(stopOldSlot).not.toHaveBeenCalled();
    expect(removeContainer).not.toHaveBeenCalled();
    expect(execCalls.some((c) => c.includes(" stop"))).toBe(false);
  });

  it("waits for this process's other deploys before a self-deploy stops its own slot", async () => {
    const order: string[] = [];
    drainMock.mockImplementationOnce(async () => {
      order.push("drain");
      return [];
    });
    const stopOldSlot = vi.fn(async () => {
      order.push("stop");
      return { ok: true as const };
    });
    const ctx = makeContext({ activeSlot: "green", stopOldSlot, stopOldSlotEndsDeploy: true });
    ctx.app.name = "vardo";

    await postDeploy(ctx);

    expect(order).toEqual(["drain", "stop"]);
    expect(unfinishedReasons()).toEqual([]);
  });

  it("names the deploys a self-deploy's stop cut off after the drain timed out", async () => {
    drainMock.mockResolvedValueOnce(["dep-stuck"]);
    const stopOldSlot = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeContext({ activeSlot: "green", stopOldSlot, stopOldSlotEndsDeploy: true });
    ctx.app.name = "vardo";

    await postDeploy(ctx);

    expect(stopOldSlot).toHaveBeenCalled();
    expect(unfinishedReasons()[0]).toContain("dep-stuck");
  });

  it("takes deploys again when a self-deploy's stop fails and the old slot keeps serving", async () => {
    endDrainMock.mockClear();
    const stopOldSlot = vi.fn().mockResolvedValue({ ok: false, message: "docker daemon unreachable" });
    const ctx = makeContext({ activeSlot: "green", stopOldSlot, stopOldSlotEndsDeploy: true });
    ctx.app.name = "vardo";

    await postDeploy(ctx);

    expect(endDrainMock).toHaveBeenCalledOnce();
  });

  it("does not drain for any other app", async () => {
    drainMock.mockClear();
    await postDeploy(makeContext({ activeSlot: "green", stopOldSlot: vi.fn().mockResolvedValue({ ok: true }) }));

    expect(drainMock).not.toHaveBeenCalled();
  });
});

describe("postDeploy for a non-default environment", () => {
  beforeEach(() => {
    writes.length = 0;
    vi.mocked(removeContainer).mockClear();
    vi.mocked(syncComposeServices).mockClear();
  });

  const preview = () =>
    makeContext({
      envName: "pr-25",
      envType: "preview",
      envIsolated: true,
      compose: { services: { web: { name: "web", image: "web" } } },
      app: { ...makeContext().app, importedContainerId: "abc123" },
    });

  it("leaves the production app row alone", async () => {
    await postDeploy(preview());

    expect(writes.filter((w) => w.table === apps)).toEqual([]);
  });

  it("never syncs the preview's compose onto production's children", async () => {
    await postDeploy(preview());

    expect(syncComposeServices).not.toHaveBeenCalled();
  });

  it("never removes production's imported container", async () => {
    vi.mocked(inspectContainer).mockResolvedValueOnce({ state: { status: "running" }, mounts: [] } as never);
    await postDeploy(preview());

    expect(removeContainer).not.toHaveBeenCalled();
  });
});
