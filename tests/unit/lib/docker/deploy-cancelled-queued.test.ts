import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DeployLoggerType from "@/lib/docker/deploy-logger";

// ---------------------------------------------------------------------------
// runDeployment — the queued row flipped to "cancelled" before run starts
//
// The DELETE route can mark a queued row as cancelled and LREM the Redis queue
// while we're still parked in claimActiveInRedis. The conditional queued→running
// flip must catch that: the row no longer matches, the deploy stops without
// touching containers, and the result reflects the row's terminal state.
// ---------------------------------------------------------------------------

import { deployments, apps } from "@/lib/db/schema";

const { dbMock, addEventMock, statusWrites } = vi.hoisted(() => {
  type Write = { table: unknown; values: Record<string, unknown> };
  const statusWrites: Write[] = [];
  const addEventMock = vi.fn().mockResolvedValue("1-0");

  // The chain returns [claimed] for any update except the deployments row's
  // queued→running flip, which returns [] so the guard fires.
  function makeUpdateChain(table: unknown) {
    let lastValues: Record<string, unknown> | undefined;
    const where = vi.fn().mockImplementation(() => ({
      returning: vi.fn().mockImplementation(() => {
        const isStatusFlip =
          table === deployments && lastValues?.status === "running";
        return Promise.resolve(isStatusFlip ? [] : [{ id: "dep-1" }]);
      }),
    }));
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      statusWrites.push({ table, values });
      lastValues = values;
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
      environments: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      deployments: {
        findFirst: vi.fn(async () => ({ status: "cancelled" })),
      },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  return { dbMock, addEventMock, statusWrites };
});

const { prepareRepo, resolveCompose, build, swap, postDeploy } = vi.hoisted(() => ({
  prepareRepo: vi.fn(),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));
const stageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: addEventMock }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/deploy-logger", async (importOriginal) => ({
  ...(await importOriginal<typeof DeployLoggerType>()),
  createDeployLogger: () => ({
    addSecrets: vi.fn(),
    addPublicNames: vi.fn(),
    redact: (text: string) => text,
    log: (line: string) => line,
    stage: stageMock,
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo,
  resolveCompose,
  build,
  swap,
  postDeploy,
}));
vi.mock("@/lib/docker/rollback-target", () => ({
  loadRollbackTarget: vi.fn(),
  applyRollbackTarget: vi.fn(),
  applyRollbackEnv: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));

import { runDeployment } from "@/lib/docker/deploy";

const OPTS = {
  appId: "app-1",
  organizationId: "org-1",
  trigger: "api" as const,
};

describe("runDeployment — cancelled queued row", () => {
  beforeEach(() => {
    statusWrites.length = 0;
    addEventMock.mockClear();
    prepareRepo.mockClear();
    resolveCompose.mockClear();
    build.mockClear();
    swap.mockClear();
    postDeploy.mockClear();
    stageMock.mockClear();
  });

  it("returns the row's terminal status without touching the deploy pipeline", async () => {
    const result = await runDeployment("dep-1", OPTS);

    expect(result.success).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(prepareRepo).not.toHaveBeenCalled();
    expect(resolveCompose).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
    expect(postDeploy).not.toHaveBeenCalled();
  });

  it("does not claim apps.status or emit a start event", async () => {
    await runDeployment("dep-1", OPTS);

    expect(statusWrites.filter((w) => w.table === apps)).toEqual([]);
    expect(addEventMock).not.toHaveBeenCalled();
  });

  it("reports superseded when the row was already marked superseded", async () => {
    vi.mocked(dbMock.query.deployments.findFirst).mockResolvedValueOnce({ status: "superseded" } as never);

    const result = await runDeployment("dep-1", OPTS);

    expect(result.status).toBe("superseded");
  });

  it("ends the deploy stream so tails don't wait for the stream cap", async () => {
    await runDeployment("dep-1", OPTS);

    expect(stageMock).toHaveBeenCalledWith("clone", "cancelled");
  });

  it("treats a missing row as cancelled (the caller decides not to retry)", async () => {
    vi.mocked(dbMock.query.deployments.findFirst).mockResolvedValueOnce(null as never);

    const result = await runDeployment("dep-1", OPTS);

    expect(result.status).toBe("cancelled");
  });
});