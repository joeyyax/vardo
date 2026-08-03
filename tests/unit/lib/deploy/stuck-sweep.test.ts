import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.mock is hoisted so factories must use vi.hoisted()
// ---------------------------------------------------------------------------

const { dbMock, redisMock, lockMock, slotsMock, rollbackMock, dockerMock, cancelMock } =
  vi.hoisted(() => {
    // Chainable Drizzle select: db.select(cols).from(t).where(c)
    const selectQueue: unknown[][] = [];
    const selectMock = vi.fn().mockImplementation(() => {
      const result = selectQueue.shift() ?? [];
      const where = vi.fn().mockResolvedValue(result);
      return { from: vi.fn().mockReturnValue({ where }) };
    });

    // Chainable Drizzle update: db.update(t).set(v).where(c).returning()
    // where() is awaitable and also carries returning(), matching the builder.
    const updateReturning: unknown[][] = [];
    const updateMock = vi.fn().mockImplementation(() => {
      const rows = updateReturning.shift() ?? [{ id: "deploy-1" }];
      const chain = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<unknown[]>;
      };
      chain.returning = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue(chain);
      return { set: vi.fn().mockReturnValue({ where }) };
    });

    const dbMock = {
      select: selectMock,
      update: updateMock,
      query: {
        deployments: { findFirst: vi.fn() },
        environments: { findFirst: vi.fn() },
      },
      _selectQueue: selectQueue,
      _updateReturning: updateReturning,
    };

    // Minimal keyspace so the sweeper's own SET NX / GET round-trips behave.
    const store = new Map<string, string>();
    const failPrefixes = new Set<string>();
    function guard(key: string) {
      for (const prefix of failPrefixes) {
        if (key.startsWith(prefix)) throw new Error("Redis unreachable");
      }
    }
    const redisMock = {
      redis: {
        get: vi.fn(async (key: string) => {
          guard(key);
          return store.get(key) ?? null;
        }),
        set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
          guard(key);
          if (args.includes("NX") && store.has(key)) return null;
          store.set(key, value);
          return "OK";
        }),
      },
      _store: store,
      _failPrefixes: failPrefixes,
    };

    return {
      dbMock,
      redisMock,
      lockMock: { acquireLock: vi.fn().mockResolvedValue(true) },
      slotsMock: { detectActiveSlot: vi.fn().mockResolvedValue("green") },
      rollbackMock: {
        performRollback: vi.fn(),
        sendRollbackNotification: vi.fn(),
        slotIsDown: vi.fn().mockResolvedValue(true),
        slotContainerIds: vi.fn(),
      },
      dockerMock: { stopProject: vi.fn().mockResolvedValue({ success: true, log: "" }) },
      cancelMock: { publishKillSignal: vi.fn().mockResolvedValue(undefined) },
    };
  });

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => ({ redis: redisMock.redis }));
vi.mock("@/lib/redis-lock", () => lockMock);
vi.mock("@/lib/docker/slots", () => slotsMock);
vi.mock("@/lib/docker/rollback-monitor", () => rollbackMock);
vi.mock("@/lib/docker/deploy", () => dockerMock);
vi.mock("@/lib/docker/deploy-cancel", () => cancelMock);
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  removeFromQueue: vi.fn(),
  reconcileActiveCounter: vi.fn(),
  reconcileQueue: vi.fn(),
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("id") }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { sweepStuckDeployments } from "@/lib/deploy/sweeper";
import { stopProject } from "@/lib/docker/deploy";
import { publishKillSignal } from "@/lib/docker/deploy-cancel";
import { slotIsDown } from "@/lib/docker/rollback-monitor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOY_ID = "deploy-1";
const APP_ID = "app-1";

/** Default budget is 15 minutes. */
const PAST_BUDGET_MS = 20 * 60_000;

const RUNNING_ROW = {
  id: DEPLOY_ID,
  appId: APP_ID,
  log: "building",
  environmentId: "env-1",
};

const APP_ROW = {
  id: APP_ID,
  organizationId: "org-1",
  name: "my-app",
  displayName: "My App",
};

/** Queue the three selects the sweep makes: running, queued, apps. */
function queueSelects(running: unknown[] = [RUNNING_ROW], appRows: unknown[] = [APP_ROW]) {
  dbMock._selectQueue.push(running, [], appRows);
}

/** Pretend the sweep first saw this deployment running `ms` ago. */
function seenRunning(ms: number) {
  redisMock._store.set(`deploy:sweep:running-since:${DEPLOY_ID}`, String(Date.now() - ms));
}

function activeKey(deploymentId: string, stage = "build") {
  redisMock._store.set(
    `deploy:active:${APP_ID}`,
    JSON.stringify({ deploymentId, stage }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sweepStuckDeployments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectQueue.length = 0;
    dbMock._updateReturning.length = 0;
    redisMock._store.clear();
    redisMock._failPrefixes.clear();
    vi.mocked(lockMock.acquireLock).mockResolvedValue(true);
    vi.mocked(slotsMock.detectActiveSlot).mockResolvedValue("green");
    vi.mocked(rollbackMock.slotIsDown).mockResolvedValue(true);
    dbMock.query.environments.findFirst.mockResolvedValue({ name: "staging" });
  });

  it("does not sweep a deploy that queued long ago but has only just started building", async () => {
    // No running-since mark yet — this pass is the first sighting, whatever the
    // row's startedAt says about how long it sat in the queue.
    queueSelects();

    await sweepStuckDeployments();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(stopProject).not.toHaveBeenCalled();
    expect(publishKillSignal).not.toHaveBeenCalled();
  });

  it("sweeps once the deploy has been observed running past the budget", async () => {
    seenRunning(PAST_BUDGET_MS);
    queueSelects();

    await sweepStuckDeployments();

    expect(dbMock.update).toHaveBeenCalled();
  });

  it("never stops a deploy that still holds the active key — it signals it to cancel", async () => {
    seenRunning(PAST_BUDGET_MS);
    activeKey(DEPLOY_ID);
    queueSelects();

    await sweepStuckDeployments();

    expect(publishKillSignal).toHaveBeenCalledWith(DEPLOY_ID);
    expect(stopProject).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("takes no destructive action when the active-deploy key is unreadable", async () => {
    seenRunning(PAST_BUDGET_MS);
    redisMock._failPrefixes.add("deploy:active:");
    queueSelects();

    await sweepStuckDeployments();

    expect(stopProject).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(publishKillSignal).not.toHaveBeenCalled();
  });

  it("takes no destructive action when Redis is unreachable entirely", async () => {
    redisMock._failPrefixes.add("deploy:");
    queueSelects();

    await expect(sweepStuckDeployments()).resolves.not.toThrow();

    expect(stopProject).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(publishKillSignal).not.toHaveBeenCalled();
  });

  it("scopes the teardown to the deployment's own environment", async () => {
    seenRunning(PAST_BUDGET_MS);
    queueSelects();

    await sweepStuckDeployments();

    expect(stopProject).toHaveBeenCalledWith(APP_ID, "my-app", "staging");
  });

  it("leaves containers alone when the environment is still serving", async () => {
    seenRunning(PAST_BUDGET_MS);
    vi.mocked(slotIsDown).mockResolvedValue(false);
    queueSelects();

    await sweepStuckDeployments();

    expect(dbMock.update).toHaveBeenCalled();
    expect(stopProject).not.toHaveBeenCalled();
  });

  it("leaves containers alone when Docker cannot be reached", async () => {
    seenRunning(PAST_BUDGET_MS);
    vi.mocked(slotIsDown).mockResolvedValue(null);
    queueSelects();

    await sweepStuckDeployments();

    expect(stopProject).not.toHaveBeenCalled();
  });

  it("fails the abandoned row but spares the containers when another deploy owns the app", async () => {
    seenRunning(PAST_BUDGET_MS);
    activeKey("deploy-2");
    queueSelects();

    await sweepStuckDeployments();

    expect(dbMock.update).toHaveBeenCalled();
    expect(stopProject).not.toHaveBeenCalled();
    expect(publishKillSignal).not.toHaveBeenCalled();
  });

  it("re-reads liveness before the teardown and aborts if a deploy claimed the app meanwhile", async () => {
    seenRunning(PAST_BUDGET_MS);
    queueSelects();

    // First read: nothing active. Second read (immediately before the teardown):
    // a new deploy has taken the app.
    let reads = 0;
    vi.mocked(redisMock.redis.get).mockImplementation(async (key: string) => {
      if (key === `deploy:active:${APP_ID}`) {
        reads += 1;
        return reads === 1 ? null : JSON.stringify({ deploymentId: "deploy-2", stage: "clone" });
      }
      return redisMock._store.get(key) ?? null;
    });

    await sweepStuckDeployments();

    expect(dbMock.update).toHaveBeenCalled();
    expect(stopProject).not.toHaveBeenCalled();
  });

  it("skips a deployment when another instance holds the sweep lock", async () => {
    seenRunning(PAST_BUDGET_MS);
    vi.mocked(lockMock.acquireLock).mockResolvedValue(false);
    queueSelects();

    await sweepStuckDeployments();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(stopProject).not.toHaveBeenCalled();
  });

  it("skips the rest of the work when the row is no longer running", async () => {
    seenRunning(PAST_BUDGET_MS);
    dbMock._updateReturning.push([]); // conditional update matched nothing
    queueSelects();

    await sweepStuckDeployments();

    expect(stopProject).not.toHaveBeenCalled();
  });
});
