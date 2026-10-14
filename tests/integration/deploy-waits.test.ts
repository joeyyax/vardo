// Why queued deploys wait, kept on their rows, against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

const { entries } = vi.hoisted(() => ({ entries: [] as { id: string; wait?: string; ahead?: number }[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/stream/producer", () => ({
  addDeployLog: vi.fn(async (id: string, entry: { wait?: string; ahead?: number }) => void entries.push({ id, wait: entry.wait, ahead: entry.ahead })),
}));

const conn = await connectScratchServer();

type Trigger = "manual" | "webhook";

describe.skipIf(!conn)("deploy waits on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deploywait");
  let sql: ReturnType<typeof postgres>;
  let w: typeof import("@/lib/deploy/waiting");
  let q: typeof import("@/lib/deploy/queue");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      for (const id of ["a1", "a2", "a3", "a4"]) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${id}, 'o1', ${id}, ${id}, 'p1')`;
      }
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('self', 'o1', 'vardo', 'Vardo', 'p1')`;
    });
    w = await import("@/lib/deploy/waiting");
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
    const rows = await sql`select id, wait_reason, wait_ahead, waiting_since from deployment order by id`;
    return Object.fromEntries(rows.map((r) => [r.id, { reason: r.wait_reason, ahead: r.wait_ahead, since: r.waiting_since }]));
  }

  it("names the app's running deploy, then a deploy slot with each deploy's place", async () => {
    await seed("r1", "a1", "manual", "running");
    await seed("q1", "a1", "manual", "queued", 30);
    await seed("q2", "a2", "webhook", "queued", 20);
    await seed("q3", "a3", "manual", "queued", 10);

    const changed = await w.markQueueWaits({ capacity: 1, workerMissing: false });
    expect(changed).toHaveLength(3);
    const rows = await waits();
    expect(rows.q1).toMatchObject({ reason: "app", ahead: null });
    // An explicit deploy goes ahead of an older automatic one, as the claim does.
    expect(rows.q3).toMatchObject({ reason: "deploy-slot", ahead: 0 });
    expect(rows.q2).toMatchObject({ reason: "deploy-slot", ahead: 1 });
    expect(rows.r1.reason).toBeNull();
    expect(entries.map((e) => [e.id, e.wait, e.ahead]).sort()).toEqual([
      ["q1", "app", undefined],
      ["q2", "deploy-slot", 1],
      ["q3", "deploy-slot", 0],
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
    expect(changed).toEqual([{ id: "q2", wait_reason: "deploy-slot", wait_ahead: 0 }]);
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
    await w.recordWait("r1", "build-slot", 2, { restart: true });
    const first = (await waits()).r1;
    expect(first).toMatchObject({ reason: "build-slot", ahead: 2 });
    expect(first.since).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await w.recordWait("r1", "build-slot", 1, { restart: false });
    expect((await waits()).r1).toMatchObject({ reason: "build-slot", ahead: 1, since: first.since });

    await w.recordWait("r1", null, undefined, { restart: false });
    expect((await waits()).r1).toMatchObject({ reason: null, ahead: null, since: null });
  });
});
