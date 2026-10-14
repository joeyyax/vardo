// Why queued deploys wait, kept on their rows, against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

const { entries } = vi.hoisted(() => ({ entries: [] as { id: string; wait?: string; ahead?: number; total?: number }[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
const { bumpBuild } = vi.hoisted(() => ({ bumpBuild: vi.fn(async () => true) }));
vi.mock("@/lib/docker/build-gate", () => ({ bumpBuild }));
vi.mock("@/lib/stream/producer", () => ({
  addDeployLog: vi.fn(async (id: string, entry: { wait?: string; ahead?: number; total?: number }) =>
    void entries.push({ id, wait: entry.wait, ahead: entry.ahead, total: entry.total }),
  ),
}));

const conn = await connectScratchServer();

type Trigger = "manual" | "webhook";

describe.skipIf(!conn)("deploy waits on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deploywait");
  let sql: ReturnType<typeof postgres>;
  let w: typeof import("@/lib/deploy/waiting");
  let q: typeof import("@/lib/deploy/queue");
  let b: typeof import("@/lib/deploy/bump");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${id}, 'o1', ${id}, ${id}, 'p1')`;
      }
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('self', 'o1', 'vardo', 'Vardo', 'p1')`;
    });
    w = await import("@/lib/deploy/waiting");
    b = await import("@/lib/deploy/bump");
    q = await import("@/lib/deploy/queue");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    await sql`delete from deployment`;
    entries.length = 0;
  });

  async function seed(id: string, appId: string, trigger: Trigger, status: "queued" | "running" | "cancelled", ageS = 0) {
    await sql`
      insert into deployment (id, app_id, trigger, status, scope_key, started_at)
      values (${id}, ${appId}, ${trigger}, ${status}, ${appId}, now() - ${ageS}::int * interval '1 second')`;
  }

  async function waits() {
    const rows = await sql`select id, wait_reason, wait_ahead, wait_total, wait_eta, waiting_since from deployment order by id`;
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        { reason: r.wait_reason, ahead: r.wait_ahead, total: r.wait_total, eta: r.wait_eta as Date | null, since: r.waiting_since },
      ]),
    );
  }

  /** A finished deploy of `appId` that took `minutes`, and built for `buildMinutes`. */
  async function history(appId: string, minutes: number, buildMinutes?: number) {
    const timings = buildMinutes === undefined ? null : { build: { startedAt: "", endedAt: "", ms: buildMinutes * 60_000 } };
    await sql`
      insert into deployment (id, app_id, trigger, status, scope_key, started_at, duration_ms, stage_timings)
      values (${`h-${appId}-${minutes}`}, ${appId}, 'manual', 'success', ${appId}, now() - interval '1 day', ${minutes * 60_000}, ${timings ? sql.json(timings) : null})`;
  }

  const MIN = 60_000;

  it("names the app's running deploy, then a deploy slot with each deploy's place", async () => {
    await seed("r1", "a1", "manual", "running");
    await seed("q1", "a1", "manual", "queued", 30);
    await seed("q2", "a2", "webhook", "queued", 20);
    await seed("q3", "a3", "manual", "queued", 10);

    const changed = await w.markQueueWaits({ capacity: 1, workerMissing: false });
    expect(changed).toHaveLength(3);
    const rows = await waits();
    expect(rows.q1).toMatchObject({ reason: "app", ahead: null, total: null });
    // An explicit deploy goes ahead of an older automatic one, as the claim does.
    expect(rows.q3).toMatchObject({ reason: "deploy-slot", ahead: 0, total: 2 });
    expect(rows.q2).toMatchObject({ reason: "deploy-slot", ahead: 1, total: 2 });
    expect(rows.r1.reason).toBeNull();
    expect(entries.map((e) => [e.id, e.wait, e.ahead, e.total]).sort()).toEqual([
      ["q1", "app", undefined, undefined],
      ["q2", "deploy-slot", 1, 2],
      ["q3", "deploy-slot", 0, 2],
    ]);
  });

  it("writes nothing when nothing changed, and keeps the start time while the reason holds", async () => {
    await seed("r1", "a1", "manual", "running");
    await seed("q2", "a2", "webhook", "queued", 20);
    await seed("q3", "a3", "manual", "queued", 10);
    await w.markQueueWaits({ capacity: 1, workerMissing: false });
    const before = await waits();
    entries.length = 0;

    expect(await w.markQueueWaits({ capacity: 1, workerMissing: false })).toEqual([]);
    expect(entries).toEqual([]);

    // q3 leaves; q2 moves up a place in the same wait.
    await sql`update deployment set status = 'cancelled' where id = 'q3'`;
    const changed = await w.markQueueWaits({ capacity: 1, workerMissing: false });
    expect(changed).toEqual([{ id: "q2", wait_reason: "deploy-slot", wait_ahead: 0, wait_total: 1, wait_eta: null }]);
    expect((await waits()).q2.since).toEqual(before.q2.since);
  });

  it("puts a missing worker first, but never on Vardo's own deploy", async () => {
    await seed("q1", "a1", "manual", "queued");
    await seed("qs", "self", "manual", "queued");
    await w.markQueueWaits({ capacity: 4, workerMissing: true });
    const rows = await waits();
    expect(rows.q1.reason).toBe("worker");
    expect(rows.qs.reason).toBeNull();
  });

  it("names Vardo's own swap over everything else but the worker", async () => {
    await seed("r1", "a1", "manual", "running");
    await sql`update deployment set exclusive_requested_at = now() where id = 'r1'`;
    await seed("q1", "a1", "manual", "queued");
    await seed("q2", "a2", "manual", "queued");
    await w.markQueueWaits({ capacity: 4, workerMissing: false });
    const rows = await waits();
    expect(rows.q1.reason).toBe("exclusive");
    expect(rows.q2.reason).toBe("exclusive");
  });

  it("clears the wait when the deploy is claimed, and tells the claimer it waited", async () => {
    await seed("r1", "a1", "manual", "running");
    await seed("q2", "a2", "manual", "queued");
    await seed("q3", "a3", "manual", "queued", 5);
    await w.markQueueWaits({ capacity: 1, workerMissing: false });
    await sql`update deployment set status = 'success', finished_at = now() where id = 'r1'`;

    const claimed = await q.claimDeploys("w", { capacity: 2 });
    expect(claimed.map((c) => [c.id, c.waited]).sort()).toEqual([["q2", true], ["q3", true]]);
    const rows = await waits();
    expect(rows.q2).toMatchObject({ reason: null, ahead: null, since: null });
  });

  it("clears waits left on finished rows", async () => {
    await seed("c1", "a1", "manual", "cancelled");
    await sql`update deployment set wait_reason = 'deploy-slot', wait_ahead = 2, waiting_since = now() where id = 'c1'`;
    expect(await w.clearFinishedWaits()).toBe(1);
    expect((await waits()).c1).toMatchObject({ reason: null, ahead: null, since: null });
  });

  it("records a running deploy's own wait and stamps a new start only on restart", async () => {
    await seed("r1", "a1", "manual", "running");
    const eta = Date.now() + 5 * MIN;
    await w.recordWait("r1", "build-slot", { ahead: 2, total: 4, eta }, { restart: true });
    const first = (await waits()).r1;
    expect(first).toMatchObject({ reason: "build-slot", ahead: 2, total: 4 });
    expect(first.eta?.getTime()).toBe(eta);
    expect(first.since).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await w.recordWait("r1", "build-slot", { ahead: 1, total: 3 }, { restart: false });
    expect((await waits()).r1).toMatchObject({ reason: "build-slot", ahead: 1, total: 3, since: first.since });

    await w.recordWait("r1", null, {}, { restart: false });
    expect((await waits()).r1).toMatchObject({ reason: null, ahead: null, total: null, eta: null, since: null });
  });

  it("sets a line's length on every deploy in it with one statement, and leaves other waits alone", async () => {
    await seed("r1", "a1", "manual", "running");
    await seed("r2", "a2", "manual", "running");
    await seed("r3", "a3", "manual", "running");
    await w.recordWait("r1", "build-slot", { ahead: 0, total: 2 }, { restart: true });
    await w.recordWait("r2", "build-slot", { ahead: 1, total: 2 }, { restart: true });
    await w.recordWait("r3", "checkout", {}, { restart: true });

    await w.recordQueueTotal("build-slot", 3);
    const rows = await waits();
    expect([rows.r1.total, rows.r2.total, rows.r3.total]).toEqual([3, 3, null]);
    expect([rows.r1.ahead, rows.r2.ahead]).toEqual([0, 1]);
  });

  describe("start estimates", () => {
    it("walks the running deploy and each deploy ahead, and stops at one without history", async () => {
      await history("a1", 5);
      await history("a2", 4);
      await history("a3", 6);
      await seed("r1", "a1", "manual", "running");
      await sql`update deployment set claimed_at = now() - interval '2 minutes' where id = 'r1'`;
      await seed("q2", "a2", "manual", "queued", 40);
      await seed("q3", "a3", "manual", "queued", 30);
      await seed("q4", "a4", "manual", "queued", 20);
      await seed("q5", "a5", "manual", "queued", 10);

      const now = Date.now();
      await w.markQueueWaits({ capacity: 1, workerMissing: false, now });
      const rows = await waits();
      const at = (id: string) => (rows[id].eta ? rows[id].eta.getTime() - now : null);
      // r1 frees 3 min from now; q2 then runs 4 and q3 6.
      expect(at("q2")).toBeCloseTo(3 * MIN, -4);
      expect(at("q3")).toBeCloseTo(7 * MIN, -4);
      expect(at("q4")).toBeCloseTo(13 * MIN, -4);
      // a4 has no history, so nothing behind it gets an estimate.
      expect(at("q5")).toBeNull();
      expect(rows.q5).toMatchObject({ reason: "deploy-slot", ahead: 3, total: 4 });
      expect(entries.find((e) => e.id === "q2")).toBeDefined();
    });

    it("gives a free slot now and an overdue deploy's slot now", async () => {
      await history("a1", 5);
      await history("a2", 4);
      await seed("r1", "a1", "manual", "running");
      await sql`update deployment set claimed_at = now() - interval '20 minutes' where id = 'r1'`;
      await seed("q2", "a2", "manual", "queued", 20);
      await seed("q3", "a3", "manual", "queued", 10);
      const now = Date.now();
      await w.markQueueWaits({ capacity: 1, workerMissing: false, now });
      const rows = await waits();
      expect(rows.q2.eta!.getTime() - now).toBeCloseTo(0, -4);
      expect(rows.q3.eta!.getTime() - now).toBeCloseTo(4 * MIN, -4);
    });

    it("rewrites an estimate only when it moves by more than 30 seconds", async () => {
      await history("a1", 5);
      await seed("r1", "a1", "manual", "running");
      await sql`update deployment set claimed_at = now() where id = 'r1'`;
      await seed("q2", "a2", "manual", "queued");
      const now = Date.now();
      await w.markQueueWaits({ capacity: 1, workerMissing: false, now });
      entries.length = 0;
      expect(await w.markQueueWaits({ capacity: 1, workerMissing: false, now: now + 20_000 })).toEqual([]);
      // Overdue by a minute: the slot frees now, a minute later than estimated.
      const later = await w.markQueueWaits({ capacity: 1, workerMissing: false, now: now + 6 * MIN });
      expect(later.map((r) => r.id)).toEqual(["q2"]);
      expect(entries.map((e) => e.id)).toEqual(["q2"]);
    });
  });

  describe("jumping the queue", () => {
    it("puts a bumped deploy first in claim order, the latest bump first", async () => {
      await seed("r1", "a1", "manual", "running");
      await seed("q2", "a2", "manual", "queued", 30);
      await seed("q3", "a3", "webhook", "queued", 20);
      await seed("q4", "a4", "webhook", "queued", 10);

      expect(await b.bumpDeploy("q4")).toBe("deploy");
      await w.markQueueWaits({ capacity: 1, workerMissing: false });
      let rows = await waits();
      expect([rows.q4.ahead, rows.q2.ahead, rows.q3.ahead]).toEqual([0, 1, 2]);

      await new Promise((r) => setTimeout(r, 10));
      expect(await b.bumpDeploy("q3")).toBe("deploy");
      await w.markQueueWaits({ capacity: 1, workerMissing: false });
      rows = await waits();
      expect([rows.q3.ahead, rows.q4.ahead, rows.q2.ahead]).toEqual([0, 1, 2]);

      await sql`update deployment set status = 'success', finished_at = now() where id = 'r1'`;
      expect((await q.claimDeploys("w", { capacity: 1 })).map((c) => c.id)).toEqual(["q3"]);
      expect((await q.claimDeploys("w", { capacity: 2 })).map((c) => c.id)).toEqual(["q4"]);
    });

    it("stays behind its own app's running deploy but goes ahead of the app's other queued deploys", async () => {
      await seed("r1", "a1", "manual", "running");
      await seed("q1a", "a1", "manual", "queued", 30);
      await seed("q1b", "a1", "webhook", "queued", 10);
      await seed("q2", "a2", "webhook", "queued", 5);

      expect(await b.bumpDeploy("q1b")).toBe("deploy");
      await w.markQueueWaits({ capacity: 1, workerMissing: false });
      expect((await waits()).q1b.reason).toBe("app");
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["q2"]);

      await sql`update deployment set status = 'success', finished_at = now() where id in ('r1', 'q2')`;
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["q1b"]);
    });

    it("moves a deploy waiting for the builder, and refuses one not waiting", async () => {
      await seed("r1", "a1", "manual", "running");
      await seed("r2", "a2", "manual", "running");
      await seed("c3", "a3", "manual", "cancelled");
      await sql`update deployment set wait_reason = 'build-slot' where id = 'r1'`;

      expect(await b.bumpDeploy("r1")).toBe("build");
      expect(bumpBuild).toHaveBeenCalledWith("r1");
      bumpBuild.mockClear();
      expect(await b.bumpDeploy("r2")).toBeNull();
      expect(await b.bumpDeploy("c3")).toBeNull();
      expect(bumpBuild).not.toHaveBeenCalled();
    });
  });
});
