// Leases, heartbeats, container holds and the migration lock against a scratch Postgres.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, journal, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

const holderRef = vi.hoisted(() => ({ current: "proc-a" }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/worker/instance", () => ({ instanceId: () => holderRef.current, instanceName: () => "test" }));

const conn = await connectScratchServer();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!conn)("worker coordination on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("worker");
  let sql: ReturnType<typeof postgres>;
  let lease: typeof import("@/lib/worker/lease");
  let fence: typeof import("@/lib/worker/fence");
  let loops: typeof import("@/lib/worker/interval-loop");
  let jobs: typeof import("@/lib/worker/jobs");
  let holds: typeof import("@/lib/docker/stop-holds");
  let migrateRuns: { code: number; out: string }[];

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    // Two containers starting together: the advisory lock serializes them.
    migrateRuns = await Promise.all([runMigrate(url), runMigrate(url)]);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    lease = await import("@/lib/worker/lease");
    fence = await import("@/lib/worker/fence");
    loops = await import("@/lib/worker/interval-loop");
    jobs = await import("@/lib/worker/jobs");
    holds = await import("@/lib/docker/stop-holds");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  describe("migration lock", () => {
    it("lets two concurrent runs apply each migration once", async () => {
      expect(migrateRuns.map((r) => r.code)).toEqual([0, 0]);
      const applied = migrateRuns.map((r) => (r.out.match(/Applying /g) ?? []).length).sort((a, b) => a - b);
      expect(applied).toEqual([0, journal.entries.length]);
      const rows = await sql`select hash, count(*)::int as n from __drizzle_migrations group by hash having count(*) > 1`;
      expect(rows).toEqual([]);
    });
  });

  describe("leader_lease", () => {
    it("acquires, renews, refuses a second holder and is stolen after expiry with a higher epoch", async () => {
      const a = await lease.acquireLease("t1", 60_000, "A");
      expect(a).toEqual({ name: "t1", holder: "A", epoch: 1 });
      expect(await lease.acquireLease("t1", 60_000, "B")).toBeNull();

      await sql`update leader_lease set expires_at = now() + interval '1 second' where name = 't1'`;
      const [before] = await sql`select expires_at from leader_lease where name = 't1'`;
      const renewed = await lease.acquireLease("t1", 60_000, "A");
      const [after] = await sql`select expires_at from leader_lease where name = 't1'`;
      expect(renewed?.epoch).toBe(1);
      expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());

      // Expiry is set on the database clock, so no stall can change what this checks.
      await sql`update leader_lease set expires_at = now() - interval '1 second' where name = 't1'`;
      const b = await lease.acquireLease("t1", 60_000, "B");
      expect(b).toEqual({ name: "t1", holder: "B", epoch: 2 });
      expect(await lease.checkFence(a!)).toBe(false);
      expect(await lease.checkFence(b!)).toBe(true);
    });

    it("a released lease is free at once", async () => {
      const a = await lease.acquireLease("t2", 60_000, "A");
      expect(await lease.acquireLease("t2", 60_000, "B")).toBeNull();
      await lease.releaseLease(a!);
      expect(await lease.acquireLease("t2", 60_000, "B")).toMatchObject({ holder: "B", epoch: 2 });
    });

    it("a pass that loses its lease stops at the next checkpoint and fails its fence", async () => {
      holderRef.current = "proc-a";
      let rows = 0;
      let fencedAfterLoss: boolean | null = null;
      const loop = new loops.IntervalLoop({
        name: "t3",
        intervalMs: 60_000,
        run: async (ctx) => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if (!ctx.active) {
              fencedAfterLoss = await fence.holdsFence();
              return;
            }
            rows++;
            await sleep(20);
          }
        },
      });
      // The keepalive renews every TTL/3, which is how the pass notices the loss.
      loop.start({ singleton: true, leaseTtlMs: 3_000 });
      const pass = loop.tick();
      for (let i = 0; i < 400 && rows < 1; i++) await sleep(25);
      expect(rows).toBeGreaterThan(0);
      // Another process takes over, as after a stall long enough to expire the lease.
      await sql`update leader_lease set holder = 'proc-b', epoch = epoch + 1, expires_at = now() + interval '1 minute' where name = 't3'`;
      await pass;
      await loop.stop();
      expect(fencedAfterLoss).toBe(false);
      // The stop left the other holder's lease alone.
      const [row] = await sql`select holder from leader_lease where name = 't3'`;
      expect(row.holder).toBe("proc-b");
    });

    it("two processes sharing a lease run each slot once, all on one holder", async () => {
      const ran: string[] = [];
      const make = () =>
        new loops.IntervalLoop({
          name: "t4",
          intervalMs: 100,
          firstRunMs: 0,
          run: async (ctx) => void ran.push(ctx.lease!.holder),
        });
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 400 && !done(); i++) await sleep(25);
        expect(done()).toBe(true);
      };
      // instanceId() is read at start, so each loop keeps the holder it started with.
      holderRef.current = "proc-a";
      const a = make();
      const startedAt = Date.now();
      a.start({ singleton: true, leaseTtlMs: 30_000 });
      await until(() => ran.length >= 1);
      holderRef.current = "proc-b";
      const b = make();
      b.start({ singleton: true, leaseTtlMs: 30_000 });
      // Waits on passes, not wall time: a starved process runs fewer slots per second.
      await until(() => ran.length >= 4);
      const elapsed = Date.now() - startedAt;
      // The standby stops first so it can't take the lease a releases.
      await b.stop();
      await a.stop();

      const [row] = await sql`select holder, epoch::int from leader_lease where name = 't4'`;
      expect(row).toMatchObject({ holder: "proc-a", epoch: 1 });
      // Every pass ran in proc-a; proc-b stayed on standby.
      expect(new Set(ran)).toEqual(new Set(["proc-a"]));
      // One pass per slot at most: a second holder running the same slots would overshoot.
      expect(ran.length).toBeLessThanOrEqual(Math.floor(elapsed / 100) + 2);
    });
  });

  describe("job_heartbeat", () => {
    it("records a tick, a clean pass and a failure streak", async () => {
      holderRef.current = "proc-a";
      let fail = false;
      const loop = new loops.IntervalLoop({
        name: "t5",
        intervalMs: 60_000,
        run: async () => {
          if (fail) throw new Error("boom");
        },
      });
      loop.start({ role: "web" });
      await loop.tick();
      await loop.flush();
      let [row] = await sql`select * from job_heartbeat where name = 't5'`;
      expect(row).toMatchObject({ role: "web", holder: "proc-a", interval_ms: 60_000, last_error: null, consecutive_failures: 0 });
      expect(row.last_ok_at).not.toBeNull();

      fail = true;
      await loop.tick();
      await loop.tick();
      await loop.flush();
      [row] = await sql`select * from job_heartbeat where name = 't5'`;
      expect(row).toMatchObject({ last_error: "boom", consecutive_failures: 2 });

      const { jobs: readings } = await jobs.readJobs(["t5", "never-ran"]);
      expect(readings.map((r) => r.state)).toEqual(["failing", "never"]);

      // A clean pass reports the streak it ended, which is what resolves a loop incident.
      expect(await jobs.recordOk("t5")).toBe(2);
      expect(await jobs.recordOk("t5")).toBe(0);
      await loop.stop();
    });
  });

  describe("container_hold", () => {
    it("is read by full or short id, released, and lapses at its expiry", async () => {
      await holds.holdStopped("abc123def456", "restore");
      expect(await holds.stopHolder("abc123def456")).toBe("restore");
      expect(await holds.stopHolder("abc123")).toBe("restore");
      expect(await holds.stopHolder("abc123def4567890")).toBe("restore");
      expect(await holds.stopHolder("fff000")).toBeNull();

      await holds.releaseStopped("abc123def456");
      expect(await holds.stopHolder("abc123def456")).toBeNull();

      await holds.holdStopped("dead00beef", "restore", 50);
      await sleep(100);
      expect(await holds.stopHolder("dead00beef")).toBeNull();
    });
  });

  describe("git poll catch-up flag", () => {
    it("is consumed by exactly one taker", async () => {
      const { takeCatchUpRequest, CATCH_UP_KEY } = await import("@/lib/git-integration/poll-scheduler");
      await sql`insert into system_settings (key, value) values (${CATCH_UP_KEY}, 'x')`;
      const taken = await Promise.all([takeCatchUpRequest(), takeCatchUpRequest(), takeCatchUpRequest()]);
      expect(taken.filter(Boolean)).toHaveLength(1);
      expect(await takeCatchUpRequest()).toBe(false);
    });
  });

  describe("worker presence", () => {
    const beat = (id: string, ago: string, draining = false) =>
      sql`insert into worker (id, role, heartbeat_at, draining_at)
          values (${id}, 'all', now() - ${ago}::interval, ${draining ? sql`now()` : null})`;
    const ids = async () => (await sql`select id from worker order by id`).map((r) => r.id);

    it("prunes rows that stopped beating a day ago and keeps a draining worker that still beats", async () => {
      const presence = await import("@/lib/worker/presence");
      await sql`delete from worker`;
      await beat("gone-2d", "2 days", true);
      await beat("gone-25h", "25 hours");
      await beat("stopped-23h", "23 hours", true);
      await beat("draining", "5 seconds", true);

      expect(await presence.pruneWorkers()).toBe(2);
      expect(await ids()).toEqual(["draining", "stopped-23h"]);
    });

    it("keeps the newest row when every worker is long gone", async () => {
      const presence = await import("@/lib/worker/presence");
      await sql`delete from worker`;
      await beat("gone-3d", "3 days");
      await beat("gone-2d", "2 days");

      expect(await presence.pruneWorkers()).toBe(1);
      expect(await ids()).toEqual(["gone-2d"]);
    });
  });
});
