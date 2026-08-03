import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runDeployment — apps.status ownership
//
// The deploy claims apps.status = "deploying" at the start, so a deploy from
// any trigger source shows as deploying. Every exit path must release it, or an
// interrupted deploy strands the app as permanently "deploying".
//
// Each case fails at the app fetch, which is the first step after the claim, so
// the exit paths run without the rest of the pipeline.
// ---------------------------------------------------------------------------

const { dbMock, addEventMock, statusWrites } = vi.hoisted(() => {
  type Write = { table: unknown; values: Record<string, unknown> };
  const statusWrites: Write[] = [];
  const addEventMock = vi.fn().mockResolvedValue("1-0");

  // db.update(table).set(values).where(cond)
  function makeUpdateChain(table: unknown) {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      statusWrites.push({ table, values });
      return { where };
    });
    return { set };
  }

  const dbMock = {
    update: vi.fn().mockImplementation((table: unknown) => makeUpdateChain(table)),
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue(undefined) },
      domains: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue(null) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
      environments: { findFirst: vi.fn().mockResolvedValue(null) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  return { dbMock, addEventMock, statusWrites };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: addEventMock }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/deploy-logger", () => ({
  createDeployLogger: () => ({
    log: (line: string) => line,
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));
vi.mock("@/lib/docker/rollback-target", () => ({
  loadRollbackTarget: vi.fn(),
  applyRollbackTarget: vi.fn(),
  applyRollbackEnv: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));

import { runDeployment } from "@/lib/docker/deploy";
import { apps } from "@/lib/db/schema";

const OPTS = {
  appId: "app-1",
  organizationId: "org-1",
  trigger: "api" as const,
};

/** apps.status values written, in order. Deployment-row writes are ignored. */
function statusSequence(): string[] {
  return statusWrites
    .filter((w) => w.table === apps && typeof w.values.status === "string")
    .map((w) => String(w.values.status));
}

function abortedSignal(reason: { supersededBy?: string; killed?: boolean }): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe("runDeployment app status ownership", () => {
  beforeEach(() => {
    statusWrites.length = 0;
    addEventMock.mockClear();
  });

  it("claims deploying and emits a start event before doing any work", async () => {
    await runDeployment("dep-1", OPTS);

    expect(statusSequence()[0]).toBe("deploying");
    expect(addEventMock.mock.calls[0][1]).toMatchObject({
      type: "deploy.status",
      status: "running",
      appId: "app-1",
      deploymentId: "dep-1",
    });
  });

  it("releases the claim to error when the deploy fails", async () => {
    const result = await runDeployment("dep-1", OPTS);

    expect(result.success).toBe(false);
    expect(statusSequence()).toEqual(["deploying", "error"]);
  });

  it("releases the claim when the user cancels", async () => {
    await runDeployment("dep-1", { ...OPTS, signal: abortedSignal({ killed: true }) });

    expect(statusSequence()).toEqual(["deploying", "stopped"]);
    expect(addEventMock.mock.calls.at(-1)?.[1]).toMatchObject({ status: "cancelled" });
  });

  it("leaves the claim alone when superseded — the newer deploy owns it", async () => {
    await runDeployment("dep-1", {
      ...OPTS,
      signal: abortedSignal({ supersededBy: "dep-2" }),
    });

    expect(statusSequence()).toEqual(["deploying"]);
    expect(addEventMock.mock.calls.at(-1)?.[1]).toMatchObject({ status: "superseded" });
  });
});
