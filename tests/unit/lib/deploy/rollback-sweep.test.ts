import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.mock is hoisted so factories must use vi.hoisted()
// ---------------------------------------------------------------------------

const { dbMock, lockMock, slotsMock, rollbackMock } = vi.hoisted(() => {
  // Chainable Drizzle select: db.select(cols).from(t).innerJoin(t, on).where(c)
  const selectQueue: unknown[][] = [];
  const selectMock = vi.fn().mockImplementation(() => {
    const result = selectQueue.shift() ?? [];
    const where = vi.fn().mockResolvedValue(result);
    const innerJoin = vi.fn().mockReturnValue({ where });
    return { from: vi.fn().mockReturnValue({ innerJoin, where }) };
  });

  const dbMock = {
    select: selectMock,
    update: vi.fn().mockImplementation(() => {
      const where = vi.fn().mockResolvedValue(undefined);
      return { set: vi.fn().mockReturnValue({ where }) };
    }),
    query: {
      deployments: { findFirst: vi.fn() },
      environments: { findFirst: vi.fn() },
    },
    _queue: selectQueue,
  };

  return {
    dbMock,
    lockMock: { acquireLock: vi.fn().mockResolvedValue(true) },
    slotsMock: { detectActiveSlot: vi.fn() },
    rollbackMock: {
      performRollback: vi.fn().mockResolvedValue(true),
      sendRollbackNotification: vi.fn().mockResolvedValue(undefined),
      slotIsDown: vi.fn(),
      slotContainerIds: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis-lock", () => lockMock);
vi.mock("@/lib/docker/slots", () => slotsMock);
vi.mock("@/lib/docker/rollback-monitor", () => rollbackMock);
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  removeFromQueue: vi.fn(),
  reconcileActiveCounter: vi.fn(),
  reconcileQueue: vi.fn(),
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: vi.fn() }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("id") }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { sweepRollbackWatches } from "@/lib/deploy/sweeper";
import { acquireLock } from "@/lib/redis-lock";
import { detectActiveSlot } from "@/lib/docker/slots";
import {
  performRollback,
  sendRollbackNotification,
  slotIsDown,
  slotContainerIds,
} from "@/lib/docker/rollback-monitor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOY_ID = "deploy-1";

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: DEPLOY_ID,
    appId: "app-1",
    trigger: "manual",
    slot: "green",
    // 30s into a 60s grace period.
    finishedAt: new Date(Date.now() - 30_000),
    environmentId: "env-1",
    appName: "my-app",
    appStatus: "active",
    organizationId: "org-1",
    gracePeriodSeconds: 60,
    ...overrides,
  };
}

/** The app's slot has no running containers and the standby has containers. */
function crashedWithStandby() {
  vi.mocked(detectActiveSlot).mockResolvedValue("green");
  vi.mocked(slotIsDown).mockResolvedValue(true);
  vi.mocked(slotContainerIds).mockResolvedValue(["abc123"]);
}

describe("sweepRollbackWatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._queue.length = 0;
    vi.mocked(dbMock.select).mockImplementation(() => {
      const result = dbMock._queue.shift() ?? [];
      const where = vi.fn().mockResolvedValue(result);
      const innerJoin = vi.fn().mockReturnValue({ where });
      return { from: vi.fn().mockReturnValue({ innerJoin, where }) } as ReturnType<
        typeof dbMock.select
      >;
    });
    vi.mocked(acquireLock).mockResolvedValue(true);
    dbMock.query.deployments.findFirst.mockResolvedValue({ id: DEPLOY_ID });
    dbMock.query.environments.findFirst.mockResolvedValue({ name: "production" });
  });

  it("rolls back a slot that stopped inside its grace period", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: DEPLOY_ID,
        currentSlot: "green",
        previousSlot: "blue",
        envName: "production",
        environmentId: "env-1",
      }),
    );
  });

  it("never rolls back a rollback", async () => {
    dbMock._queue.push([candidateRow({ trigger: "rollback" })]);
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("resumes a watch the previous process never held", async () => {
    // Nothing primed this module — the window comes entirely from the row, which
    // is what a restart mid-grace-period leaves behind.
    dbMock._queue.push([candidateRow({ finishedAt: new Date(Date.now() - 55_000) })]);
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).toHaveBeenCalledTimes(1);
  });

  it("ignores a deploy whose grace period lapsed while the process was down", async () => {
    dbMock._queue.push([candidateRow({ finishedAt: new Date(Date.now() - 120_000) })]);
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
    expect(slotIsDown).not.toHaveBeenCalled();
  });

  it("never rolls back Vardo itself", async () => {
    dbMock._queue.push([candidateRow({ appName: "vardo" })]);
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("skips a deploy that a later deployment superseded", async () => {
    dbMock._queue.push([candidateRow()]);
    dbMock.query.deployments.findFirst.mockResolvedValue({ id: "deploy-2" });
    crashedWithStandby();

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("skips when the serving slot has changed since the deploy", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();
    vi.mocked(detectActiveSlot).mockResolvedValue("blue");

    await sweepRollbackWatches();

    expect(slotIsDown).not.toHaveBeenCalled();
    expect(performRollback).not.toHaveBeenCalled();
  });

  it("does not roll back while the slot is still serving", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();
    vi.mocked(slotIsDown).mockResolvedValue(false);

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("does not roll back when Docker is unreachable", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();
    vi.mocked(slotIsDown).mockResolvedValue(null);

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("reports instead of rolling back when the standby slot is empty", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();
    vi.mocked(slotContainerIds).mockResolvedValue([]);

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
    expect(sendRollbackNotification).toHaveBeenCalledWith(
      "org-1",
      "app-1",
      "my-app",
      false,
      expect.stringContaining("blue"),
    );
  });

  it("attempts a rollback once per deployment across instances", async () => {
    dbMock._queue.push([candidateRow()]);
    crashedWithStandby();
    vi.mocked(acquireLock).mockResolvedValue(false);

    await sweepRollbackWatches();

    expect(performRollback).not.toHaveBeenCalled();
  });

  it("keeps sweeping after one candidate throws", async () => {
    const other = candidateRow({ deploymentId: "deploy-9", appId: "app-9", appName: "other" });
    dbMock._queue.push([candidateRow(), other]);
    crashedWithStandby();
    dbMock.query.deployments.findFirst
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValue({ id: "deploy-9" });

    await sweepRollbackWatches();

    expect(performRollback).toHaveBeenCalledTimes(1);
    expect(performRollback).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: "deploy-9" }),
    );
  });
});
