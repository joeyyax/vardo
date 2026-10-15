// A console died holding nightly jobs that were still waiting for a slot. The sweep reruns each once, on a real Redis.
// Skips without a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/backups/engine", () => ({ REQUEUE_TRIGGER: "requeue" }));
vi.mock("@/lib/backups/reap", () => ({ INTERRUPTED_REASON: "Backup interrupted", reapInterruptedBackups: vi.fn() }));
vi.mock("@/lib/backups/runs", () => ({ markJobDone: vi.fn() }));

async function connect(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const client = await connect();

describe.skipIf(!client)("orphaned run jobs on Redis", () => {
  const NOW = new Date("2026-10-11T09:10:00Z");
  const runId = `it-orphan-${process.pid}-${Date.now()}`;
  const jobIds = ["radarr-movies", "scrypted", "openwebui"];
  let dbMock: typeof import("@/tests/helpers/db").dbMock;
  let requeue: typeof import("@/lib/backups/requeue");
  let lease: typeof import("@/lib/backups/run-lease");

  const keys = () => jobIds.flatMap((j) => [requeue.requeueLockKey(runId, j), lease.runJobLeaseKey(runId, j)]);

  beforeEach(async () => {
    ({ dbMock } = await import("@/tests/helpers/db"));
    requeue = await import("@/lib/backups/requeue");
    lease = await import("@/lib/backups/run-lease");
    dbMock.reset();
    await client!.del(...keys());
    dbMock.query.backupRuns.findMany.mockResolvedValue([
      {
        id: runId,
        organizationId: "org-1",
        startedAt: new Date("2026-10-11T09:00:00Z"),
        estimatedMs: 20 * 60_000,
        deadlineAt: new Date("2026-10-11T10:00:00Z"),
        finishedAt: null,
        plan: { jobs: [...jobIds, "done-job"].map((jobId) => ({ jobId, jobName: jobId })), apps: [], target: null, jobLeases: true },
        jobsDone: ["done-job"],
      },
    ]);
    dbMock.query.backups.findFirst.mockResolvedValue(undefined);
    dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "job", name: "job", enabled: true });
  });

  afterAll(async () => {
    if (requeue) await client!.del(...keys());
    client!.disconnect();
    const { redis } = await import("@/lib/redis");
    redis.disconnect();
  });

  it("leaves jobs alone while the console holding them is alive", async () => {
    const releases = await Promise.all(jobIds.map((j) => lease.holdRunJobLease(runId, j)));
    const runJob = vi.fn(() => Promise.resolve());

    expect(await requeue.requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
    await Promise.all(releases.map((r) => r()));
  });

  it("reruns each never-started job once across two consoles once the holder is gone", async () => {
    const blue = vi.fn(() => Promise.resolve());
    const green = vi.fn(() => Promise.resolve());

    const [a, b] = await Promise.all([
      requeue.requeueOrphanedRunJobs(NOW, { runJob: blue }),
      requeue.requeueOrphanedRunJobs(NOW, { runJob: green }),
    ]);
    const later = await requeue.requeueOrphanedRunJobs(new Date(NOW.getTime() + 5 * 60_000), { runJob: blue });

    expect(a.length + b.length).toBe(jobIds.length);
    expect(blue.mock.calls.length + green.mock.calls.length).toBe(jobIds.length);
    expect(later).toEqual([]);
    for (const j of jobIds) expect(await client!.exists(requeue.requeueLockKey(runId, j))).toBe(1);
  });
});
