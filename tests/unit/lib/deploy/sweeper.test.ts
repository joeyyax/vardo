import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.mock is hoisted so factories must use vi.hoisted()
// ---------------------------------------------------------------------------

const { dbMock, lockMock, removeMock, eventsMock, emitMock, streamMock } = vi.hoisted(() => {
  const emitMock = vi.fn();

  // Chainable Drizzle select mock: db.select(cols).from(table).where(cond)
  // Responses are queued and consumed in FIFO order.
  const selectQueue: unknown[][] = [];
  function makeSelectChain(result: unknown[]) {
    const where = vi.fn().mockResolvedValue(result);
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  }
  const selectMock = vi.fn().mockImplementation(() => {
    const result = selectQueue.shift() ?? [];
    return makeSelectChain(result);
  });

  // Chainable Drizzle update mock: db.update(table).set(vals).where(cond)
  function makeUpdateChain() {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    return { set, where };
  }

  const dbMock = {
    select: selectMock,
    update: vi.fn().mockImplementation(() => makeUpdateChain()),
    _queue: selectQueue,
  };

  const lockMock = { acquireLock: vi.fn().mockResolvedValue(true) };
  const removeMock = {
    removeFromQueue: vi.fn().mockResolvedValue(undefined),
    reconcileActiveCounter: vi.fn().mockResolvedValue(undefined),
    reconcileQueue: vi.fn().mockResolvedValue(undefined),
  };
  const eventsMock = {
    publishEvent: vi.fn().mockResolvedValue(undefined),
    appChannel: vi.fn().mockReturnValue("app:test-channel"),
  };
  const streamMock = {
    addEvent: vi.fn().mockResolvedValue("stream-id-1"),
  };

  return { dbMock, lockMock, removeMock, eventsMock, emitMock, streamMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis-lock", () => lockMock);
vi.mock("@/lib/docker/deploy-concurrency", () => removeMock);
vi.mock("@/lib/events", () => eventsMock);
vi.mock("@/lib/stream/producer", () => streamMock);
vi.mock("@/lib/notifications/dispatch", () => ({ emit: emitMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { sweepStuckQueuedDeployments } from "@/lib/deploy/sweeper";
import { addEvent } from "@/lib/stream/producer";
import { acquireLock } from "@/lib/redis-lock";
import { removeFromQueue } from "@/lib/docker/deploy-concurrency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAST_CUTOFF = new Date(Date.now() - 40 * 60_000); // 40 min ago (beyond 2×15 = 30 min cutoff)

function queueSelectResults(...results: unknown[][]) {
  dbMock._queue.push(...results);
}

const TEST_DEPLOY = {
  id: "deploy-queued-1",
  appId: "app-1",
  startedAt: PAST_CUTOFF,
};

const TEST_APP = {
  id: "app-1",
  organizationId: "org-1",
  name: "my-app",
  displayName: "My App",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sweepStuckQueuedDeployments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._queue.length = 0;
    // Restore the select mock to use the queue
    vi.mocked(dbMock.select).mockImplementation(() => {
      const result = dbMock._queue.shift() ?? [];
      const where = vi.fn().mockResolvedValue(result);
      const from = vi.fn().mockReturnValue({ where });
      return { from } as ReturnType<typeof dbMock.select>;
    });
    // Restore the update mock
    vi.mocked(dbMock.update).mockImplementation(() => {
      const where = vi.fn().mockResolvedValue(undefined);
      const set = vi.fn().mockReturnValue({ where });
      return { set, where } as ReturnType<typeof dbMock.update>;
    });
  });

  it("cancels a stuck queued deployment and removes it from the Redis queue", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);

    await sweepStuckQueuedDeployments();

    // DB updated to cancelled status
    expect(dbMock.update).toHaveBeenCalled();

    // Removed from Redis queue
    expect(removeFromQueue).toHaveBeenCalledWith(TEST_DEPLOY.id);

    // SSE event published
    expect(addEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "deploy:complete", status: "cancelled" }),
    );
  });

  it("skips deployments that are still within the timeout window", async () => {
    // DB returns no stuck deployments (all within timeout)
    queueSelectResults([]);

    await sweepStuckQueuedDeployments();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(removeFromQueue).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
  });

  it("skips a deployment when another instance holds the lock", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);
    vi.mocked(acquireLock).mockResolvedValueOnce(false);

    await sweepStuckQueuedDeployments();

    // Lock not acquired — nothing should happen
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(removeFromQueue).not.toHaveBeenCalled();
  });

  it("dispatches a notification for the cancelled deployment", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);

    await sweepStuckQueuedDeployments();

    expect(emitMock).toHaveBeenCalledWith(
      TEST_APP.organizationId,
      expect.objectContaining({
        type: "deploy.failed",
        appId: TEST_DEPLOY.appId,
        deploymentId: TEST_DEPLOY.id,
      }),
    );
  });

  it("notification failure does not prevent cancellation from completing", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);
    emitMock.mockImplementationOnce(() => {
      throw new Error("notification service unavailable");
    });

    // Should not throw — notification failure is non-fatal
    await expect(sweepStuckQueuedDeployments()).resolves.not.toThrow();

    // Deployment was still cancelled
    expect(dbMock.update).toHaveBeenCalled();
    expect(removeFromQueue).toHaveBeenCalledWith(TEST_DEPLOY.id);
  });

  it("handles multiple stuck deployments in one sweep", async () => {
    const deploy2 = { id: "deploy-queued-2", appId: "app-2", startedAt: PAST_CUTOFF };
    const app2 = { id: "app-2", organizationId: "org-1", name: "app-two", displayName: "App Two" };

    queueSelectResults([TEST_DEPLOY, deploy2], [TEST_APP, app2]);

    await sweepStuckQueuedDeployments();

    expect(removeFromQueue).toHaveBeenCalledTimes(2);
    expect(removeFromQueue).toHaveBeenCalledWith(TEST_DEPLOY.id);
    expect(removeFromQueue).toHaveBeenCalledWith(deploy2.id);
  });
});
