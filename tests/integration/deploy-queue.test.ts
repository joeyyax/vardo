// The Postgres deploy queue against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const conn = await connectScratchServer();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Trigger = "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";

describe.skipIf(!conn)("deploy queue on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deployq");
  let sql: ReturnType<typeof postgres>;
  let q: typeof import("@/lib/deploy/queue");

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
      await t`insert into environment (id, app_id, name, is_default) values ('e-prod', 'a1', 'production', true), ('e-stage', 'a1', 'staging', false)`;
      for (let i = 0; i < 20; i++) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${`bulk${i}`}, 'o1', ${`bulk${i}`}, 'Bulk', 'p1')`;
      }
    });
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
  });

  /** A row written directly, with a start time `ageS` seconds ago. */
  async function seed(
    id: string,
    appId: string,
    trigger: Trigger,
    status: "queued" | "running",
    opts: { ageS?: number; stage?: string; scope?: string | null; claimedBy?: string } = {},
  ) {
    const scope = opts.scope === undefined ? appId : opts.scope;
    await sql`
      insert into deployment (id, app_id, trigger, status, scope_key, stage, claimed_by, started_at)
      values (${id}, ${appId}, ${trigger}, ${status}, ${scope}, ${opts.stage ?? null}, ${opts.claimedBy ?? null},
        now() - ${opts.ageS ?? 0}::int * interval '1 second')`;
  }

  async function row(id: string) {
    const [r] = await sql`select status, superseded_by, cancel_requested_at, cancel_reason, claimed_by, scope_key, request from deployment where id = ${id}`;
    return r;
  }

  const finish = (id: string) => sql`update deployment set status = 'success', finished_at = now() where id = ${id}`;

  describe("one running per scope", () => {
    it("the index refuses a second running row in a scope", async () => {
      await seed("r1", "a1", "manual", "running");
      await expect(seed("r2", "a1", "webhook", "running")).rejects.toThrow(/deployment_scope_running_uniq/);
      // Another scope of the same app is free.
      await seed("r3", "a1", "manual", "running", { scope: "a1:e-stage" });
    });

    it("claims nothing in a scope that has a running row, then its next row once it ends", async () => {
      await seed("r1", "a1", "manual", "running", { claimedBy: "x" });
      await seed("q1", "a1", "manual", "queued", { ageS: 10 });
      await seed("q2", "a1", "manual", "queued", { ageS: 5 });
      await seed("elsewhere", "a2", "webhook", "queued");
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["elsewhere"]);
      await finish("r1");
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["q1"]);
      expect(await q.claimDeploys("w", { capacity: 10 })).toEqual([]);
    });

    it("a pre-queue running row holds every scope of its app until it ends", async () => {
      await seed("q1", "a1", "manual", "queued");
      await seed("q-stage", "a1", "manual", "queued", { scope: "a1:e-stage" });
      await seed("other", "a2", "manual", "queued");
      await seed("legacy", "a1", "manual", "running", { scope: null });
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["other"]);
      await finish("legacy");
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id).sort()).toEqual(["q-stage", "q1"]);
    });
  });

  describe("capacity", () => {
    it("counts every running row host-wide, legacy ones included", async () => {
      await seed("legacy", "a5", "manual", "running", { scope: null });
      await seed("q1", "a1", "webhook", "queued", { ageS: 30 });
      await seed("q2", "a2", "webhook", "queued", { ageS: 20 });
      await seed("q3", "a3", "webhook", "queued", { ageS: 10 });
      expect((await q.claimDeploys("w", { capacity: 3 })).map((c) => c.id)).toEqual(["q1", "q2"]);
      expect(await q.claimDeploys("w", { capacity: 3 })).toEqual([]);
      await finish("legacy");
      expect((await q.claimDeploys("w", { capacity: 3 })).map((c) => c.id)).toEqual(["q3"]);
      const [lease] = await sql`select claimed_by, lease_expires_at > now() as live from deployment where id = 'q3'`;
      expect(lease).toEqual({ claimed_by: "w", live: true });
    });
  });

  describe("order", () => {
    it("claims an explicit deploy before an older automatic one in the same scope", async () => {
      await seed("auto", "a1", "webhook", "queued", { ageS: 60 });
      await seed("man", "a1", "manual", "queued", { ageS: 1 });
      expect((await q.claimDeploys("w", { capacity: 5 })).map((c) => c.id)).toEqual(["man"]);
    });

    it("across scopes, explicit first, then oldest", async () => {
      await seed("poll-old", "a1", "poll", "queued", { ageS: 90 });
      await seed("hook", "a2", "webhook", "queued", { ageS: 60 });
      await seed("api-new", "a3", "api", "queued", { ageS: 5 });
      await seed("man-mid", "a4", "manual", "queued", { ageS: 30 });
      expect((await q.claimDeploys("w", { capacity: 1 })).map((c) => c.id)).toEqual(["man-mid"]);
      expect((await q.claimDeploys("w", { capacity: 2 })).map((c) => c.id)).toEqual(["api-new"]);
      await sql`delete from deployment where status = 'running'`;
      expect((await q.claimDeploys("w", { capacity: 5 })).map((c) => c.id)).toEqual(["poll-old", "hook"]);
    });

    it("splits the self app from everything else", async () => {
      await seed("vardo", "self", "manual", "queued", { ageS: 10 });
      await seed("other", "a1", "manual", "queued", { ageS: 5 });
      expect((await q.claimDeploys("worker", { capacity: 5, self: "exclude" })).map((c) => c.id)).toEqual(["other"]);
      expect((await q.claimDeploys("web", { capacity: 5, self: "only" })).map((c) => c.id)).toEqual(["vardo"]);
    });

    it("at capacity 1 a freed slot goes to Vardo's own deploy, whichever claimer runs first", async () => {
      await seed("build", "a1", "manual", "running", { claimedBy: "worker" });
      await seed("other", "a2", "manual", "queued", { ageS: 60 });
      await seed("vardo", "self", "api", "queued", { ageS: 5 });
      await sql`update deployment set bumped_at = now() where id = 'other'`;
      await finish("build");

      expect(await q.claimDeploys("worker", { capacity: 1, self: "exclude" })).toEqual([]);
      expect((await q.claimDeploys("web", { capacity: 1, self: "only" })).map((c) => c.id)).toEqual(["vardo"]);
      await finish("vardo");
      expect((await q.claimDeploys("worker", { capacity: 1, self: "exclude" })).map((c) => c.id)).toEqual(["other"]);
    });

    it("the worker leaves one slot per ready self-deploy and takes the rest", async () => {
      await seed("vardo", "self", "api", "queued", { ageS: 5 });
      await seed("o1", "a1", "manual", "queued", { ageS: 30 });
      await seed("o2", "a2", "manual", "queued", { ageS: 20 });
      expect((await q.claimDeploys("worker", { capacity: 2, self: "exclude" })).map((c) => c.id)).toEqual(["o1"]);
    });

    it("one claimer for everything takes Vardo's own first", async () => {
      await seed("other", "a1", "manual", "queued", { ageS: 60 });
      await seed("vardo", "self", "api", "queued", { ageS: 5 });
      await sql`update deployment set bumped_at = now() where id = 'other'`;
      expect((await q.claimDeploys("w", { capacity: 1 })).map((c) => c.id)).toEqual(["vardo"]);
      expect((await q.claimDeploys("w", { capacity: 2 })).map((c) => c.id)).toEqual(["other"]);
    });
  });

  describe("enqueue", () => {
    it("stores the scope and the request, keyed by environment off the default", async () => {
      const prod = await q.enqueueDeploy({ appId: "a1", trigger: "manual", environmentId: "e-prod", rebuild: "force" });
      const stage = await q.enqueueDeploy({ appId: "a1", trigger: "manual", environmentId: "e-stage", gitSha: "abc" });
      expect(await row(prod.id)).toMatchObject({ status: "queued", scope_key: "a1", request: { rebuild: "force" } });
      expect(await row(stage.id)).toMatchObject({ status: "queued", scope_key: "a1:e-stage", request: { gitSha: "abc" } });
    });

    it("an automatic deploy supersedes older queued automatic rows in its scope only", async () => {
      await seed("old-hook", "a1", "webhook", "queued", { ageS: 20 });
      await seed("old-poll", "a1", "poll", "queued", { ageS: 10 });
      await seed("queued-manual", "a1", "manual", "queued", { ageS: 15 });
      await seed("other-scope", "a1", "webhook", "queued", { scope: "a1:e-stage" });
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "relay" });
      expect(res.superseded.sort()).toEqual(["old-hook", "old-poll"]);
      expect(await row("old-hook")).toMatchObject({ status: "superseded", superseded_by: res.id });
      expect(await row("old-poll")).toMatchObject({ status: "superseded", superseded_by: res.id });
      expect(await row("queued-manual")).toMatchObject({ status: "queued", superseded_by: null });
      expect(await row("other-scope")).toMatchObject({ status: "queued" });
    });

    it("an automatic deploy asks a running automatic build to stop", async () => {
      await seed("building", "a1", "webhook", "running", { stage: "build" });
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "webhook", gitSha: "def", pinIntent: "push" });
      expect(res.cancelRequested).toEqual(["building"]);
      expect(await row("building")).toMatchObject({ status: "running", cancel_reason: "supersede" });
      expect((await row("building")).cancel_requested_at).not.toBeNull();
    });

    it("an automatic deploy also stops one claimed but not yet cloning", async () => {
      await seed("claimed", "a1", "poll", "running");
      expect((await q.enqueueDeploy({ appId: "a1", trigger: "poll" })).cancelRequested).toEqual(["claimed"]);
    });

    it("an automatic deploy leaves a running automatic row past the build alone", async () => {
      await seed("swapping", "a1", "webhook", "running", { stage: "healthcheck" });
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "webhook" });
      expect(res.cancelRequested).toEqual([]);
      expect(await row("swapping")).toMatchObject({ cancel_requested_at: null, cancel_reason: null });
    });

    it("an automatic deploy never stops a running explicit build", async () => {
      await seed("manual-build", "a1", "manual", "running", { stage: "build" });
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "webhook" });
      expect(res.cancelRequested).toEqual([]);
      expect(await row("manual-build")).toMatchObject({ cancel_requested_at: null });
    });

    it("a head-tracking manual deploy supersedes queued automatic rows but never touches a running build", async () => {
      await seed("building", "a1", "webhook", "running", { stage: "build" });
      await seed("queued-hook", "a1", "webhook", "queued", { ageS: 5 });
      await seed("queued-api", "a1", "api", "queued", { ageS: 4 });
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "manual" });
      expect(res).toMatchObject({ superseded: ["queued-hook"], cancelRequested: [] });
      expect(await row("queued-hook")).toMatchObject({ status: "superseded", superseded_by: res.id });
      expect(await row("queued-api")).toMatchObject({ status: "queued" });
      expect(await row("building")).toMatchObject({ status: "running", cancel_requested_at: null, cancel_reason: null });
      // Explicit rows run oldest first once the build ends.
      await finish("building");
      expect((await q.claimDeploys("w", { capacity: 5 })).map((c) => c.id)).toEqual(["queued-api"]);
    });

    it("a manual deploy pinned to a commit supersedes nothing and leaves the running build", async () => {
      await seed("building", "a1", "webhook", "running", { stage: "clone" });
      await seed("queued-hook", "a1", "webhook", "queued");
      const res = await q.enqueueDeploy({ appId: "a1", trigger: "manual", gitSha: "0ld" });
      expect(res).toMatchObject({ superseded: [], cancelRequested: [] });
      expect(await row("queued-hook")).toMatchObject({ status: "queued" });
      expect(await row("building")).toMatchObject({ cancel_requested_at: null });
    });

    it("api tracks the head like manual; a rollback never does", async () => {
      await seed("h1", "a1", "webhook", "queued");
      expect((await q.enqueueDeploy({ appId: "a1", trigger: "rollback", rollback: { targetDeploymentId: "old" } })).superseded).toEqual([]);
      expect(await row("h1")).toMatchObject({ status: "queued" });
      expect((await q.enqueueDeploy({ appId: "a1", trigger: "api" })).superseded).toEqual(["h1"]);
    });

    it("concurrent automatic enqueues in one scope leave one queued", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => q.enqueueDeploy({ appId: "a2", trigger: i % 2 ? "webhook" : "poll" })),
      );
      const queued = await sql`select id from deployment where scope_key = 'a2' and status = 'queued'`;
      expect(queued).toHaveLength(1);
      expect(results.map((r) => r.id)).toContain(queued[0].id);
    });
  });

  describe("releasing a pre-queue push", () => {
    it("gives way to a newer queued or running push and leaves it alone", async () => {
      await seed("old", "a1", "webhook", "queued", { ageS: 300, scope: null });
      await seed("new-build", "a1", "webhook", "running", { ageS: 60, stage: "build", claimedBy: "w" });
      await seed("new-queued", "a1", "poll", "queued", { ageS: 30 });
      expect(await q.releaseHeldDeploy("old")).toBe(false);
      expect(await row("old")).toMatchObject({ status: "superseded", superseded_by: "new-queued", scope_key: null });
      expect(await row("new-queued")).toMatchObject({ status: "queued", superseded_by: null });
      expect(await row("new-build")).toMatchObject({ status: "running", cancel_requested_at: null });
    });

    it("supersedes older queued pushes when it is the newest", async () => {
      await seed("older", "a1", "webhook", "queued", { ageS: 600 });
      await seed("old", "a1", "webhook", "queued", { ageS: 300, scope: null });
      await seed("other-env", "a1", "webhook", "queued", { ageS: 10, scope: "a1:e-stage" });
      expect(await q.releaseHeldDeploy("old")).toBe(true);
      expect(await row("old")).toMatchObject({ status: "queued", scope_key: "a1" });
      expect(await row("older")).toMatchObject({ status: "superseded", superseded_by: "old" });
      expect(await row("other-env")).toMatchObject({ status: "queued" });
    });
  });

  describe("cancel", () => {
    it("cancels a queued row outright; it is never claimed", async () => {
      await seed("q1", "a1", "manual", "queued");
      expect(await q.requestCancel("q1", "user")).toBe("cancelled");
      expect(await row("q1")).toMatchObject({ status: "cancelled", cancel_reason: "user" });
      expect(await q.claimDeploys("w", { capacity: 5 })).toEqual([]);
      expect(await q.requestCancel("q1", "user")).toBe("inactive");
    });

    it("flags a running row, and a user cancel replaces a supersede", async () => {
      await seed("r1", "a1", "webhook", "running", { stage: "build", claimedBy: "w" });
      await q.enqueueDeploy({ appId: "a1", trigger: "webhook" });
      expect(await row("r1")).toMatchObject({ cancel_reason: "supersede" });
      expect(await q.requestCancel("r1", "user")).toBe("requested");
      expect(await row("r1")).toMatchObject({ status: "running", cancel_reason: "user" });
      expect(await q.requestCancel("r1", "supersede")).toBe("requested");
      expect(await row("r1")).toMatchObject({ cancel_reason: "user" });
    });
  });

  describe("leases", () => {
    it("renews held rows and returns cancel requests and rows held elsewhere", async () => {
      await seed("a", "a1", "manual", "queued");
      await seed("b", "a2", "manual", "queued");
      await seed("c", "a3", "manual", "queued");
      await q.claimDeploys("w1", { capacity: 5, leaseMs: 1_000 });
      await sql`update deployment set claimed_by = 'w2' where id = 'c'`;
      await q.requestCancel("b", "user");
      const [before] = await sql`select lease_expires_at from deployment where id = 'a'`;

      const renewal = await q.renewLeases("w1", ["a", "b", "c", "gone"]);
      expect(renewal.cancel).toEqual([{ id: "b", reason: "user" }]);
      expect(renewal.lost.sort()).toEqual(["c", "gone"]);
      const [after] = await sql`select lease_expires_at from deployment where id = 'a'`;
      expect(after.lease_expires_at.getTime() - before.lease_expires_at.getTime()).toBeGreaterThan(30_000);
      // w2's lease is untouched.
      const [c] = await sql`select lease_expires_at < now() + interval '2 seconds' as short from deployment where id = 'c'`;
      expect(c.short).toBe(true);
    });

    it("loses a row that stopped running", async () => {
      await seed("a", "a1", "manual", "queued");
      await q.claimDeploys("w1", { capacity: 5 });
      await finish("a");
      expect(await q.renewLeases("w1", ["a"])).toEqual({ cancel: [], lost: ["a"] });
    });
  });

  describe("exclusive swaps", () => {
    it("blocks every claim while set, and claims resume once released", async () => {
      await seed("self", "self", "manual", "running", { claimedBy: "web" });
      await seed("q1", "a1", "manual", "queued");
      await seed("q2", "a2", "webhook", "queued");
      const wait = await q.requestExclusive("self", { timeoutMs: 0 });
      expect(wait).toMatchObject({ running: 0 });
      expect(await q.claimDeploys("w", { capacity: 10 })).toEqual([]);
      expect(await q.claimDeploys("web", { capacity: 10, self: "only" })).toEqual([]);
      await q.releaseExclusive("self");
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id).sort()).toEqual(["q1", "q2"]);
    });

    it("still blocks after the deploy finishes, until released", async () => {
      await seed("self", "self", "manual", "running");
      await seed("q1", "a1", "manual", "queued");
      await q.requestExclusive("self", { timeoutMs: 0 });
      await finish("self");
      expect(await q.claimDeploys("w", { capacity: 10 })).toEqual([]);
    });

    it("ignores a flag left past its maximum age", async () => {
      await seed("self", "self", "manual", "running");
      await seed("q1", "a1", "manual", "queued");
      await sql`update deployment set exclusive_requested_at = now() - interval '31 minutes' where id = 'self'`;
      expect((await q.claimDeploys("w", { capacity: 10 })).map((c) => c.id)).toEqual(["q1"]);
    });

    it("waits for other running deploys, reporting how many", async () => {
      await seed("self", "self", "manual", "running");
      await seed("b1", "a1", "webhook", "running", { stage: "build" });
      await seed("b2", "a2", "manual", "running", { stage: "build" });
      const notices: number[] = [];
      const pending = q.requestExclusive("self", { pollMs: 20, noticeMs: 0, onWait: (n) => notices.push(n) });
      await sleep(100);
      await finish("b1");
      await sleep(100);
      await finish("b2");
      expect(await pending).toMatchObject({ running: 0 });
      expect(notices).toContain(2);
      expect(notices).toContain(1);
    });

    it("gives up waiting at the timeout and returns how many still run", async () => {
      await seed("self", "self", "manual", "running");
      await seed("b1", "a1", "manual", "running");
      const res = await q.requestExclusive("self", { pollMs: 20, timeoutMs: 100 });
      expect(res.running).toBe(1);
      expect(res.waitedMs).toBeGreaterThanOrEqual(100);
    });

    it("waits for a claim already in flight and counts what it claimed", async () => {
      await seed("self", "self", "manual", "running");
      await seed("q1", "a1", "manual", "queued");
      // A claim that has checked for a hold and not yet committed.
      const claimer = await sql.reserve();
      await claimer`begin`;
      await claimer`select pg_advisory_xact_lock(hashtext('vardo:deploy-claim'))`;
      await claimer`update deployment set status = 'running', claimed_by = 'w' where id = 'q1'`;
      const pending = q.requestExclusive("self", { timeoutMs: 0 });
      try {
        await sleep(300);
      } finally {
        await claimer`commit`;
        claimer.release();
      }
      expect((await pending).running).toBe(1);
    });

    it("clears the flag when the wait is aborted", async () => {
      await seed("self", "self", "manual", "running");
      await seed("b1", "a1", "manual", "running");
      const ac = new AbortController();
      const pending = q.requestExclusive("self", { pollMs: 20, signal: ac.signal });
      await sleep(50);
      ac.abort(new Error("stop"));
      await expect(pending).rejects.toThrow("stop");
      const [r] = await sql`select exclusive_requested_at from deployment where id = 'self'`;
      expect(r.exclusive_requested_at).toBeNull();
    });
  });

  describe("concurrent claims", () => {
    it("two claimers in flight together never claim a row twice or exceed capacity", async () => {
      for (let i = 0; i < 20; i++) await seed(`b${i}`, `bulk${i}`, i % 3 ? "webhook" : "manual", "queued", { ageS: 100 - i });

      // Hold the claim lock so both calls are provably waiting at once, then let them race.
      const waiters = async () => {
        const [w] = await sql`select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database where l.locktype = 'advisory' and not l.granted and d.datname = current_database()`;
        return w.n as number;
      };
      const holder = await sql.reserve();
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext('vardo:deploy-claim'))`;
      const both = Promise.all([q.claimDeploys("w1", { capacity: 12 }), q.claimDeploys("w2", { capacity: 12 })]);
      try {
        for (let i = 0; i < 100 && (await waiters()) !== 2; i++) await sleep(20);
        expect(await waiters()).toBe(2);
      } finally {
        await holder`commit`;
        holder.release();
      }

      const [a, b] = await both;
      const ids = [...a, ...b].map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(12);
      const rows = await sql`select id, claimed_by from deployment where status = 'running'`;
      expect(rows).toHaveLength(12);
      for (const r of rows) expect(r.claimed_by).toBe(a.some((c) => c.id === r.id) ? "w1" : "w2");
    });

    it("claimers started together stay within capacity", async () => {
      for (let round = 0; round < 5; round++) {
        await sql`delete from deployment`;
        for (let i = 0; i < 20; i++) await seed(`b${i}`, `bulk${i}`, "webhook", "queued", { ageS: 100 - i });
        const results = await Promise.all(["w1", "w2", "w3", "w4"].map((w) => q.claimDeploys(w, { capacity: 6 })));
        const ids = results.flat().map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(6);
      }
    });

    it("skips a row another transaction holds instead of waiting for it", async () => {
      await seed("held", "a1", "manual", "queued", { ageS: 10 });
      await seed("free", "a2", "manual", "queued", { ageS: 5 });
      const locker = await sql.reserve();
      await locker`begin`;
      await locker`select id from deployment where id = 'held' for update`;
      try {
        const claimed = await Promise.race([
          q.claimDeploys("w", { capacity: 5 }),
          sleep(3_000).then(() => "blocked" as const),
        ]);
        expect(claimed).not.toBe("blocked");
        expect((claimed as { id: string }[]).map((c) => c.id)).toEqual(["free"]);
      } finally {
        await locker`rollback`;
        locker.release();
      }
      expect((await q.claimDeploys("w", { capacity: 5 })).map((c) => c.id)).toEqual(["held"]);
    });
  });

  describe("queue counts", () => {
    it("idle and drained read the table", async () => {
      expect(await q.isDeployQueueIdleInDb()).toBe(true);
      await seed("r1", "a1", "manual", "running");
      expect(await q.isDeployQueueIdleInDb()).toBe(false);
      expect(await q.isDeployQueueDrainedInDb()).toBe(true);
      await seed("q1", "a2", "manual", "queued");
      expect(await q.isDeployQueueDrainedInDb()).toBe(false);
      await sql`delete from deployment where id = 'q1'`;
      await seed("r2", "a2", "manual", "running");
      expect(await q.isDeployQueueDrainedInDb()).toBe(false);
    });
  });

  describe("enterSwap", () => {
    it("retries a failed write instead of reading it as a lost claim, and throws once Postgres stays away", async () => {
      const { db } = await import("@/lib/db");
      await seed("r1", "a1", "manual", "queued");
      await q.claimDeploys("w", { capacity: 5 });
      const update = vi.spyOn(db, "update");
      try {
        update.mockImplementationOnce(() => {
          throw new Error("connection reset");
        });
        expect(await q.enterSwap("w", "r1", { retryEveryMs: 10 })).toBe(true);
        expect((await sql`select stage from deployment where id = 'r1'`)[0].stage).toBe("deploy");

        update.mockImplementation(() => {
          throw new Error("connection reset");
        });
        await expect(q.enterSwap("w", "r1", { retryEveryMs: 10, retryForMs: 50 })).rejects.toThrow(/Couldn't confirm/);
      } finally {
        update.mockRestore();
      }
      expect(await q.enterSwap("other", "r1")).toBe(false);
    });
  });

  describe("awaitClaim", () => {
    it("returns once claimed, and cancels a row nobody claims in time", async () => {
      await seed("q1", "a1", "manual", "queued");
      const pending = q.awaitClaim("q1", 5_000, { pollMs: 20 });
      await sleep(60);
      await q.claimDeploys("w", { capacity: 5 });
      expect(await pending).toBe(true);

      await seed("q2", "a2", "manual", "queued");
      expect(await q.awaitClaim("q2", 100, { pollMs: 20 })).toBe(false);
      expect(await row("q2")).toMatchObject({ status: "cancelled", cancel_reason: "timeout" });
    });
  });

  describe("awaitDeployment", () => {
    it("resolves on the terminal row", async () => {
      await seed("r1", "a1", "manual", "running");
      const pending = q.awaitDeployment("r1", { pollMs: 20 });
      await sleep(60);
      await sql`update deployment set status = 'failed', finished_at = now() where id = 'r1'`;
      expect(await pending).toMatchObject({ id: "r1", status: "failed" });
    });
  });
});
