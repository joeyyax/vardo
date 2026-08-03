import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runDeployment — terminal stage events and the persisted log
//
// Every way a deploy can end must emit a stage event, or the SSE stream stays
// open until its 10-minute timeout and the UI silently stops deploying with
// nothing to show. The log must also reach the row at every stage transition,
// so a process killed mid-deploy leaves something behind.
// ---------------------------------------------------------------------------

const { dbMock, events, hooksMock, dockerCalls } = vi.hoisted(() => {
  type Event = { kind: "stage" | "log-flush" | "row"; detail: string };
  const events: Event[] = [];
  const dockerCalls: string[] = [];

  const appRow = {
    id: "app-1",
    name: "app",
    displayName: "App",
    organizationId: "org-1",
    projectId: null,
    source: "git",
    deployType: "compose",
    envContent: null,
    containerPort: 3000,
    domains: [] as unknown[],
  };

  function makeUpdateChain(table: unknown) {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      const isDeploymentRow = typeof values.status === "string" && "finishedAt" in values;
      if (isDeploymentRow) events.push({ kind: "row", detail: String(values.status) });
      else if (Object.keys(values).length === 1 && typeof values.log === "string") {
        events.push({ kind: "log-flush", detail: values.log });
      }
      void table;
      return { where };
    });
    return { set };
  }

  const dbMock = {
    update: vi.fn().mockImplementation((table: unknown) => makeUpdateChain(table)),
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue(appRow) },
      domains: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: "org-1", name: "Org", baseDomain: null, trusted: false }) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
      environments: { findFirst: vi.fn().mockResolvedValue(null) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  const hooksMock = vi.fn().mockResolvedValue({ allowed: true });

  return { dbMock, events, hooksMock, dockerCalls };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("1-0") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: hooksMock }));
vi.mock("@/lib/docker/deploy-logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/deploy-logger")>()),
  createDeployLogger: () => ({
    log: (line: string) => line,
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(async (ctx) => {
    ctx.checkAbort();
    ctx.log("[deploy] cloned");
    ctx.stage("clone", "success");
    ctx.stage("compose", "running");
    return ctx;
  }),
  resolveCompose: vi.fn(async (ctx) => ctx),
  build: vi.fn(async (ctx) => ctx),
  swap: vi.fn(async (ctx) => ctx),
  postDeploy: vi.fn(async (ctx) => ctx),
}));
vi.mock("@/lib/docker/rollback-target", () => ({
  loadRollbackTarget: vi.fn(),
  applyRollbackTarget: vi.fn(),
  applyRollbackEnv: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: unknown) => void) => {
    dockerCalls.push([cmd, ...args].join(" "));
    cb(null);
  },
}));
vi.mock("@/lib/docker/compose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/compose")>()),
  slotComposeFiles: vi.fn(async () => ["-f", "docker-compose.yml"]),
}));

import { runDeployment } from "@/lib/docker/deploy";
import { build, prepareRepo, swap, postDeploy } from "@/lib/docker/deploy-steps";

const OPTS = {
  appId: "app-1",
  organizationId: "org-1",
  trigger: "api" as const,
};

type StageCall = [string, string];

function stageCalls(): StageCall[] {
  return onStage.mock.calls as StageCall[];
}

const onStage = vi.fn();

function abortedSignal(reason: { supersededBy?: string; killed?: boolean }): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

/** Let the fire-and-forget log flushes settle. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("runDeployment terminal stages", () => {
  beforeEach(() => {
    events.length = 0;
    onStage.mockClear();
    hooksMock.mockResolvedValue({ allowed: true });
    vi.mocked(build).mockImplementation(async (ctx) => ctx);
  });

  it("emits a failed stage when a step throws", async () => {
    vi.mocked(build).mockRejectedValue(new Error("compose write failed"));

    const result = await runDeployment("dep-1", { ...OPTS, onStage });

    expect(stageCalls().at(-1)).toEqual(["compose", "failed"]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("compose write failed");
  });

  it("emits a failed stage when the user cancels", async () => {
    const result = await runDeployment("dep-1", {
      ...OPTS,
      onStage,
      signal: abortedSignal({ killed: true }),
    });

    expect(stageCalls().at(-1)?.[1]).toBe("failed");
    expect(result.status).toBe("cancelled");
  });

  it("emits a failed stage when superseded by a newer deploy", async () => {
    const result = await runDeployment("dep-1", {
      ...OPTS,
      onStage,
      signal: abortedSignal({ supersededBy: "dep-2" }),
    });

    expect(stageCalls().at(-1)?.[1]).toBe("failed");
    expect(result.status).toBe("superseded");
  });

  it("emits a failed stage when a hook blocks the deploy", async () => {
    hooksMock.mockResolvedValue({
      allowed: false,
      blockedBy: { hookName: "approval", reason: "needs sign-off" },
    });

    const result = await runDeployment("dep-1", { ...OPTS, onStage });

    expect(stageCalls().at(-1)?.[1]).toBe("failed");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("approval");
  });

  it("reports success without a failed stage", async () => {
    const result = await runDeployment("dep-1", { ...OPTS, onStage });

    expect(stageCalls().some(([, status]) => status === "failed")).toBe(false);
    expect(result.status).toBe("success");
    expect(result.error).toBeUndefined();
  });

  it("emits the failed stage before the deployment row is written", async () => {
    vi.mocked(build).mockRejectedValue(new Error("boom"));
    onStage.mockImplementation((stage: string, status: string) => {
      events.push({ kind: "stage", detail: `${stage}:${status}` });
    });

    await runDeployment("dep-1", { ...OPTS, onStage });

    const failedAt = events.findIndex((e) => e.kind === "stage" && e.detail.endsWith(":failed"));
    const rowAt = events.findIndex((e) => e.kind === "row");
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThan(failedAt);
    onStage.mockImplementation(() => {});
  });
});

describe("runDeployment log persistence", () => {
  beforeEach(() => {
    events.length = 0;
    onStage.mockClear();
    hooksMock.mockResolvedValue({ allowed: true });
    vi.mocked(build).mockImplementation(async (ctx) => ctx);
  });

  it("writes the log at every stage transition, not only at the end", async () => {
    await runDeployment("dep-1", { ...OPTS, onStage });
    await settle();

    const flushes = events.filter((e) => e.kind === "log-flush");
    expect(flushes.length).toBeGreaterThanOrEqual(stageCalls().length);
    expect(flushes.at(-1)?.detail).toContain("[deploy] cloned");
  });

  it("keeps the log of a deploy interrupted before its final write", async () => {
    // Nothing after the clone stage completes — the only log the row can have is
    // the one flushed at that transition.
    vi.mocked(build).mockImplementation(() => new Promise(() => {}));

    void runDeployment("dep-1", { ...OPTS, onStage });
    await settle();

    const flushes = events.filter((e) => e.kind === "log-flush");
    expect(events.some((e) => e.kind === "row")).toBe(false);
    expect(flushes.at(-1)?.detail).toContain("[deploy] cloned");
  });
});

describe("runDeployment open stages", () => {
  it("closes a phase a step left open when the next one starts", async () => {
    vi.mocked(prepareRepo).mockImplementation(async (ctx) => ctx);
    vi.mocked(build).mockImplementation(async (ctx) => {
      ctx.stage("deploy", "running");
      return ctx;
    });
    onStage.mockClear();

    await runDeployment("dep-1", { ...OPTS, onStage });

    const calls = stageCalls();
    const closed = calls.findIndex(([s, status]) => s === "clone" && status === "success");
    const opened = calls.findIndex(([s, status]) => s === "deploy" && status === "running");
    expect(closed).toBeGreaterThanOrEqual(0);
    expect(closed).toBeLessThan(opened);
  });
});

describe("runDeployment failures between phases", () => {
  // Swap ends on routing, postDeploy opens cleanup — a throw in that gap has no
  // phase in flight to blame.
  beforeEach(() => {
    dockerCalls.length = 0;
    onStage.mockClear();
    hooksMock.mockResolvedValue({ allowed: true });
    vi.mocked(prepareRepo).mockImplementation(async (ctx) => ctx);
    vi.mocked(build).mockImplementation(async (ctx) => ctx);
    vi.mocked(swap).mockImplementation(async (ctx) => {
      ctx.slotDir = "/srv/vardo/app/blue";
      ctx.newProjectName = "app-prod-blue";
      ctx.stage("routing", "running");
      ctx.stage("routing", "success");
      return ctx;
    });
    vi.mocked(postDeploy).mockRejectedValue(new Error("died before cleanup"));
  });

  it("leaves the succeeded phase alone and blames the one that never ran", async () => {
    const result = await runDeployment("dep-1", { ...OPTS, onStage });

    expect(stageCalls()).not.toContainEqual(["routing", "failed"]);
    expect(stageCalls().at(-1)).toEqual(["cleanup", "failed"]);
    expect(result.status).toBe("failed");
  });

  it("still tears down the containers the deploy started", async () => {
    await runDeployment("dep-1", { ...OPTS, onStage });

    expect(dockerCalls.some((c) => c.includes("-p app-prod-blue down"))).toBe(true);
  });
});
