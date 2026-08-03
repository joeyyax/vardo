import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runDeployment — the deploy that succeeded but did not finish its tail
//
// Between "failed" and "succeeded" sits a release that cut over and is serving
// while post-deploy work behind it did not complete. It keeps its success, its
// app status and its stream; the unfinished work is recorded against the row
// and notified on its own event.
// ---------------------------------------------------------------------------

const { dbMock, writes, emitMock, addEventMock } = vi.hoisted(() => {
  type Write = { table: unknown; values: Record<string, unknown> };
  const writes: Write[] = [];
  const emitMock = vi.fn();
  const addEventMock = vi.fn().mockResolvedValue("1-0");

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
      writes.push({ table, values });
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

  return { dbMock, writes, emitMock, addEventMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: addEventMock }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: vi.fn().mockResolvedValue({ allowed: true }) }));
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
  prepareRepo: vi.fn(async (ctx) => ctx),
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
vi.mock("@/lib/notifications/dispatch", () => ({ emit: emitMock }));
vi.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(null),
}));

import { runDeployment } from "@/lib/docker/deploy";
import { postDeploy } from "@/lib/docker/deploy-steps";
import { apps, deployments } from "@/lib/db/schema";

const OPTS = {
  appId: "app-1",
  organizationId: "org-1",
  trigger: "api" as const,
};

/** Values written to a table, in order. */
function writesTo(table: unknown): Record<string, unknown>[] {
  return writes.filter((w) => w.table === table).map((w) => w.values);
}

function emittedTypes(): string[] {
  return emitMock.mock.calls.map((call) => (call[1] as { type: string }).type);
}

describe("a deploy whose post-deploy work did not finish", () => {
  beforeEach(() => {
    writes.length = 0;
    emitMock.mockClear();
    addEventMock.mockClear();
    vi.mocked(postDeploy).mockImplementation(async (ctx) => {
      ctx.succeeded = true;
      ctx.stage("done", "success");
      throw new Error("after.deploy.success hooks did not run");
    });
  });

  it("reports the deploy as succeeded and names the unfinished work", async () => {
    const result = await runDeployment("dep-1", OPTS);

    expect(result.success).toBe(true);
    expect(result.status).toBe("success");
    expect(result.postDeployError).toContain("hooks did not run");
  });

  it("never overwrites the success the deploy already recorded", async () => {
    await runDeployment("dep-1", OPTS);

    const statuses = writesTo(deployments).map((v) => v.status);
    expect(statuses).not.toContain("failed");
  });

  it("records what was left undone on the deployment row", async () => {
    await runDeployment("dep-1", OPTS);

    const noted = writesTo(deployments).find((v) => "postDeployError" in v);
    expect(noted).toBeDefined();
  });

  it("leaves the app active — it is serving the release", async () => {
    await runDeployment("dep-1", OPTS);

    const statuses = writesTo(apps).map((v) => v.status);
    expect(statuses).not.toContain("error");
  });

  it("notifies on its own event rather than as a failure", async () => {
    await runDeployment("dep-1", OPTS);

    expect(emittedTypes()).toContain("deploy.incomplete");
    expect(emittedTypes()).not.toContain("deploy.failed");
    expect(emitMock.mock.calls.at(-1)?.[1]).toMatchObject({
      appId: "app-1",
      deploymentId: "dep-1",
      reason: expect.stringContaining("hooks did not run"),
    });
  });
});

describe("a deploy that failed before it committed", () => {
  beforeEach(() => {
    writes.length = 0;
    emitMock.mockClear();
    vi.mocked(postDeploy).mockImplementation(async () => {
      throw new Error("cutover failed");
    });
  });

  it("still reports failed, errors the app and notifies", async () => {
    const result = await runDeployment("dep-1", OPTS);
    // The failure notification is fire-and-forget behind a dynamic import.
    await new Promise((r) => setTimeout(r, 10));

    expect(result.status).toBe("failed");
    expect(writesTo(deployments).map((v) => v.status)).toContain("failed");
    expect(writesTo(apps).map((v) => v.status)).toContain("error");
    expect(emittedTypes()).toContain("deploy.failed");
    expect(emittedTypes()).not.toContain("deploy.incomplete");
  });
});
