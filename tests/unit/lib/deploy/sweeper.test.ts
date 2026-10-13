import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEPLOY_TIMEOUT_MS } from "@/lib/docker/constants";

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
vi.mock("@/lib/docker/deploy-cancel", () => ({
  deployScope: vi.fn(async (appId: string) => appId),
  deployWorker: vi.fn().mockResolvedValue("gone"),
  publishKillSignal: vi.fn(),
}));
vi.mock("@/lib/git-integration/github-feedback", () => ({
  deployTimedOut: vi.fn().mockResolvedValue(undefined),
  queuedDeployCancelled: vi.fn().mockResolvedValue(undefined),
}));
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
import { deployWorker } from "@/lib/docker/deploy-cancel";
import { queuedDeployCancelled } from "@/lib/git-integration/github-feedback";
import { knownFailure } from "@/lib/git-integration/deploy-failure";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAST_CUTOFF = new Date(Date.now() - 2 * DEPLOY_TIMEOUT_MS - 10 * 60_000);

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

const updates: Record<string, unknown>[] = [];
/** Rows each conditional update's returning() yields, in order. */
const returningQueue: unknown[][] = [];

// Queued five minutes ago: past the orphan threshold, inside the queue timeout.
const RECENT_DEPLOY = {
  id: "deploy-queued-recent",
  appId: "app-1",
  startedAt: new Date(Date.now() - 5 * 60_000),
  log: "[queue] Waiting for the deploy already running for this app",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function resetMocks() {
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
  updates.length = 0;
  returningQueue.length = 0;
  vi.mocked(dbMock.update).mockImplementation(() => {
    // Awaitable, with returning() for the conditional cancel.
    const where = vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => returningQueue.shift() ?? [{ id: "row" }]) }),
    );
    const set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
      updates.push(values);
      return { where };
    });
    return { set, where } as ReturnType<typeof dbMock.update>;
  });
  vi.mocked(deployWorker).mockResolvedValue("gone");
}

describe("sweepStuckQueuedDeployments", () => {
  beforeEach(resetMocks);

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
      expect.objectContaining({ type: "deploy.status", status: "cancelled" }),
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
    vi.mocked(acquireLock).mockResolvedValueOnce(null);

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

describe("sweepStuckQueuedDeployments for a deploy whose process died", () => {
  beforeEach(resetMocks);

  it("cancels it and appends the reason to its log", async () => {
    queueSelectResults([RECENT_DEPLOY], [TEST_APP]);

    await sweepStuckQueuedDeployments();

    expect(deployWorker).toHaveBeenCalledWith(RECENT_DEPLOY.id);
    expect(updates[0]).toMatchObject({ status: "cancelled" });
    expect(updates[0].log).toMatch(/^\[queue\] Waiting for the deploy already running for this app\n.*\[CANCELLED\] .*never started/);
    expect(removeFromQueue).toHaveBeenCalledWith(RECENT_DEPLOY.id);
  });

  it("leaves a deploy waiting behind another deploy of its app", async () => {
    queueSelectResults([RECENT_DEPLOY], [TEST_APP]);
    vi.mocked(deployWorker).mockResolvedValue("live");

    await sweepStuckQueuedDeployments();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(removeFromQueue).not.toHaveBeenCalled();
  });

  it("leaves it when Redis can't say whether its worker lives", async () => {
    queueSelectResults([RECENT_DEPLOY], [TEST_APP]);
    vi.mocked(deployWorker).mockResolvedValue("unknown");

    await sweepStuckQueuedDeployments();

    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("cancels a deploy past the queue timeout without asking for its worker", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);
    vi.mocked(deployWorker).mockResolvedValue("live");

    await sweepStuckQueuedDeployments();

    expect(deployWorker).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("sweepStuckQueuedDeployments on GitHub", () => {
  beforeEach(resetMocks);

  it("reports an orphaned deploy as cancelled before it started", async () => {
    queueSelectResults([RECENT_DEPLOY], [TEST_APP]);

    await sweepStuckQueuedDeployments();
    await new Promise((r) => setImmediate(r));

    expect(queuedDeployCancelled).toHaveBeenCalledTimes(1);
    const [id, message] = vi.mocked(queuedDeployCancelled).mock.calls[0];
    expect(id).toBe(RECENT_DEPLOY.id);
    expect(knownFailure(message)).toBe("The deploy was cancelled before it started.");
  });

  it("reports a deploy stuck past the queue timeout with its limit", async () => {
    queueSelectResults([TEST_DEPLOY], [TEST_APP]);

    await sweepStuckQueuedDeployments();
    await new Promise((r) => setImmediate(r));

    const message = vi.mocked(queuedDeployCancelled).mock.calls[0][1];
    expect(knownFailure(message)).toBe(`The deploy waited in the queue longer than ${(2 * DEPLOY_TIMEOUT_MS) / 60_000} minutes and was cancelled.`);
  });

  it("does nothing more for a deploy that left the queue meanwhile", async () => {
    queueSelectResults([RECENT_DEPLOY], [TEST_APP]);
    returningQueue.push([]);

    await sweepStuckQueuedDeployments();
    await new Promise((r) => setImmediate(r));

    expect(queuedDeployCancelled).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("keeps sweeping when GitHub feedback throws", async () => {
    const second = { ...TEST_DEPLOY, id: "deploy-queued-2" };
    queueSelectResults([TEST_DEPLOY, second], [TEST_APP]);
    vi.mocked(queuedDeployCancelled).mockImplementationOnce(() => { throw new Error("boom"); });

    await expect(sweepStuckQueuedDeployments()).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(addEvent).mock.calls.map((c) => (c[1] as { deploymentId: string }).deploymentId)).toEqual([TEST_DEPLOY.id, second.id]);
  });
});
