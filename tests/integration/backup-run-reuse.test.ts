// A nightly run and a run started by hand never back up the same job at once, and each reuses the other near the nightly time.
// Skips without a Postgres it can create databases on (MIGRATE_TEST_ADMIN_URL, DATABASE_URL or .env) or a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import Redis from "ioredis";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import type { BackupResultItem } from "@/lib/backups/run-rules";

const h = vi.hoisted(() => ({ runBackup: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/setup", () => ({ needsSetup: async () => false }));
vi.mock("@/lib/resources/host", () => ({ loadResourceSettings: async () => ({}), maxBackupConcurrency: async () => 1 }));
vi.mock("@/lib/backups/initial-backup", () => ({ startDueInitialBackups: async () => [] }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/notifications/observations", () => ({ fireAlert: vi.fn(), settleAlerts: vi.fn() }));
vi.mock("@/lib/backups/engine", async (orig) => ({ ...(await orig<typeof import("@/lib/backups/engine")>()), runBackup: h.runBackup }));

async function connectRedis(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
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

const conn = await connectScratchServer();
const client = conn ? await connectRedis() : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

describe.skipIf(!conn || !client)("nightly and manual runs of one job on Postgres and Redis", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("backup_reuse");
  let sql: ReturnType<typeof postgres>;
  let tick: typeof import("@/lib/backups/tick");
  let manual: typeof import("@/lib/backups/manual-run");
  let runs: typeof import("@/lib/backups/runs");
  let slots: typeof import("@/lib/backups/run-limit");
  let claimKey: (jobId: string) => string;
  let n = 0;
  let jobId: string;
  let now: Date;

  /** A result item as the engine records it. */
  const item = (backupId: string, outcome: BackupResultItem["outcome"] = "success"): BackupResultItem => ({
    kind: "backup",
    appId: null,
    appName: "Shop",
    volumeName: "data",
    jobId,
    jobName: "Auto: Shop",
    outcome,
    sizeBytes: 100,
    durationMs: 1000,
    ...(outcome === "failed" ? { error: "tar exited 2" } : {}),
    backupId,
    at: new Date().toISOString(),
  });

  /** Engine stand-in: records one result into the run it was given, after `gate` opens. */
  const engine = (gate: Promise<void> = Promise.resolve()) =>
    h.runBackup.mockImplementation(async (id: string, opts: { runId?: string | null; trigger?: string }) => {
      await gate;
      const result = item(opts.trigger === "manual" ? "bk-manual" : "bk-nightly");
      await runs.recordBackupResults("o1", [result], { runId: opts.runId ?? null });
      return [{ backupId: result.backupId, appId: "", volumeName: "data", outcome: "success", sizeBytes: 100, storagePath: "", durationMs: 1000 }];
    });

  const nightlyRun = async () => {
    const [run] = await sql`select id, jobs_done, items from backup_run where kind = 'nightly'`;
    return run as { id: string; jobs_done: string[]; items: BackupResultItem[] } | undefined;
  };

  /** A manual run of the job started `ago` ms before now that finished with these results. */
  const seedManualRun = async (ago: number, items: BackupResultItem[]) => {
    const at = new Date(now.getTime() - ago);
    await sql`insert into backup_run (id, organization_id, kind, run_key, label, started_at, deadline_at, finished_at, plan, jobs_done, items)
      values (${`m-${n++}`}, 'o1', 'job', ${`manual:${jobId}:${at.getTime()}`}, 'Auto: Shop', ${at}, ${new Date(at.getTime() + 60 * MIN)}, ${at},
        ${sql.json({ jobs: [{ jobId, jobName: "Auto: Shop" }], apps: [], target: null })}, ${sql.json([jobId])}, ${sql.json(items)})`;
  };

  /** Holds the only backup slot until released. */
  const fillSlot = async () => {
    let release!: () => void;
    const running = slots.withBackupSlot(1, () => new Promise<void>((r) => (release = r)));
    await vi.waitFor(() => expect(release).toBeDefined());
    return async () => {
      release();
      await running;
    };
  };

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql`insert into organization (id, name, slug, time_zone) values ('o1', 'Homelab', 'homelab', 'UTC')`;
    await sql`insert into backup_target (id, organization_id, name, type, config) values ('t1', 'o1', 'Local', 'local', ${sql.json({ path: "/tmp" })})`;
    tick = await import("@/lib/backups/tick");
    manual = await import("@/lib/backups/manual-run");
    runs = await import("@/lib/backups/runs");
    slots = await import("@/lib/backups/run-limit");
    claimKey = (await import("@/lib/backups/job-claim")).jobClaimKey;
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
    client!.disconnect();
    const { redis } = await import("@/lib/redis");
    redis.disconnect();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    h.runBackup.mockReset();
    engine();
    await sql`delete from backup_run`;
    await sql`delete from backup_job`;
    // Unique per test and process: the Redis is shared.
    jobId = `reuse-${process.pid}-${Date.now()}-${n++}`;
    now = new Date();
    const hhmm = now.toISOString().slice(11, 16);
    await sql`update organization set nightly_backup_time = ${hhmm} where id = 'o1'`;
    await sql`insert into backup_job (id, organization_id, target_id, name, enabled, nightly) values (${jobId}, 'o1', 't1', 'Auto: Shop', true, true)`;
    await client!.del(claimKey(jobId));
  });

  it("keeps the nightly run from starting a job a manual run holds while it waits for a slot, then records that backup", async () => {
    const free = await fillSlot();
    const start = await manual.startManualBackup(jobId);
    expect(start.started).toBe(true);

    const ticking = tick.tickBackupJobs(now, { claimPollMs: 20 });
    await sleep(300);
    // Neither run has a backup row yet; the nightly run waits on the manual one.
    expect(h.runBackup).not.toHaveBeenCalled();
    expect((await nightlyRun())?.jobs_done).toEqual([]);

    await free();
    await (start.started && start.done);
    await ticking;

    expect(h.runBackup).toHaveBeenCalledTimes(1);
    expect(h.runBackup).toHaveBeenCalledWith(jobId, expect.objectContaining({ trigger: "manual" }));
    const run = await nightlyRun();
    expect(run?.jobs_done).toEqual([jobId]);
    expect(run?.items.map((i) => i.backupId)).toEqual(["bk-manual"]);
    expect(await client!.exists(claimKey(jobId))).toBe(0);
  });

  it("records a manual backup from 3 minutes before as the job's result, failures included, and doesn't requeue it", async () => {
    await seedManualRun(3 * MIN, [item("bk-early"), { ...item("bk-early-2", "failed"), volumeName: "db" }]);

    await tick.tickBackupJobs(now, { claimPollMs: 20 });

    expect(h.runBackup).not.toHaveBeenCalled();
    const run = await nightlyRun();
    expect(run?.jobs_done).toEqual([jobId]);
    expect(run?.items.map((i) => [i.backupId, i.outcome])).toEqual([
      ["bk-early", "success"],
      ["bk-early-2", "failed"],
    ]);

    const { requeueOrphanedRunJobs } = await import("@/lib/backups/requeue");
    const rerun = vi.fn(() => Promise.resolve());
    expect(await requeueOrphanedRunJobs(new Date(now.getTime() + 2 * MIN), { runJob: rerun })).toEqual([]);
    expect(rerun).not.toHaveBeenCalled();
  });

  it("runs the job itself when the manual backup is 20 minutes old", async () => {
    await seedManualRun(20 * MIN, [item("bk-old")]);

    await tick.tickBackupJobs(now, { claimPollMs: 20 });

    const run = await nightlyRun();
    expect(h.runBackup).toHaveBeenCalledWith(jobId, { runId: run?.id });
    expect(run?.jobs_done).toEqual([jobId]);
    expect(run?.items.map((i) => i.backupId)).toEqual(["bk-nightly"]);
  });

  it("joins a manual request to the nightly run in progress, before and after it reaches a slot", async () => {
    const free = await fillSlot();
    let open!: () => void;
    engine(new Promise<void>((r) => (open = r)));

    const ticking = tick.tickBackupJobs(now, { claimPollMs: 20 });
    await vi.waitFor(async () => expect(await client!.exists(claimKey(jobId))).toBe(1));
    // Waiting for a slot: no backup row yet.
    expect(await manual.startManualBackup(jobId)).toEqual({ started: false, startedAt: now });

    await free();
    await vi.waitFor(() => expect(h.runBackup).toHaveBeenCalledTimes(1));
    expect(await manual.startManualBackup(jobId)).toEqual({ started: false, startedAt: now });

    open();
    await ticking;
    // Done, but the nightly run started under 5 minutes ago.
    const joined = await manual.startManualBackup(jobId);
    expect(joined.started).toBe(false);
    expect(h.runBackup).toHaveBeenCalledTimes(1);
    expect((await nightlyRun())?.items.map((i) => i.backupId)).toEqual(["bk-nightly"]);
  });

  /** A nightly run that opened `ago` ms before now and still waits on the job, as a console that died mid-wait leaves it. */
  const seedOrphanedNightly = async (ago: number) => {
    const at = new Date(now.getTime() - ago);
    await sql`insert into backup_run (id, organization_id, kind, run_key, label, started_at, deadline_at, plan, jobs_done)
      values (${`n-${n++}`}, 'o1', 'nightly', 'nightly:orphaned', 'Nightly backups', ${at}, ${new Date(at.getTime() + 60 * MIN)},
        ${sql.json({ jobs: [{ jobId, jobName: "Auto: Shop" }], apps: [], target: null, jobLeases: true })}, ${sql.json([])})`;
    return at;
  };

  const requeueOrphans = async () => {
    const { requeueOrphanedRunJobs } = await import("@/lib/backups/requeue");
    expect(await requeueOrphanedRunJobs(now)).toEqual([jobId]);
    await vi.waitFor(async () => expect((await nightlyRun())?.jobs_done).toEqual([jobId]));
    await vi.waitFor(async () => expect(await client!.exists(claimKey(jobId))).toBe(0));
  };

  it("records the manual backup a requeued nightly job waited on instead of running it again", async () => {
    await seedOrphanedNightly(10 * MIN);
    await seedManualRun(11 * MIN, [item("bk-manual")]);

    await requeueOrphans();

    expect(h.runBackup).not.toHaveBeenCalled();
    expect((await nightlyRun())?.items.map((i) => i.backupId)).toEqual(["bk-manual"]);
  });

  it("runs a requeued nightly job when the manual backup started before the nightly window", async () => {
    await seedOrphanedNightly(10 * MIN);
    await seedManualRun(16 * MIN, [item("bk-manual")]);

    await requeueOrphans();

    expect(h.runBackup).toHaveBeenCalledTimes(1);
    expect((await nightlyRun())?.items.map((i) => i.backupId)).toEqual(["bk-nightly"]);
  });

  it("starts a manual run once the nightly run is more than 5 minutes old", async () => {
    const at = new Date(now.getTime() - 6 * MIN);
    await sql`insert into backup_run (id, organization_id, kind, run_key, label, started_at, deadline_at, plan, jobs_done)
      values ('n-old', 'o1', 'nightly', 'nightly:old', 'Nightly backups', ${at}, ${new Date(at.getTime() + 60 * MIN)},
        ${sql.json({ jobs: [{ jobId, jobName: "Auto: Shop" }], apps: [], target: null, jobLeases: true })}, ${sql.json([jobId])})`;

    const start = await manual.startManualBackup(jobId);
    expect(start.started).toBe(true);
    await (start.started && start.done);
    expect(h.runBackup).toHaveBeenCalledWith(jobId, expect.objectContaining({ trigger: "manual" }));
  });
});
