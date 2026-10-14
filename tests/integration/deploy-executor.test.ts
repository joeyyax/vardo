// The deploy executor, claim pass, crash rule and exclusive swaps against a scratch Postgres. The engine is a stand-in.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import type { DeployOpts, DeployResult } from "@/lib/docker/deploy";
import { ownSlot } from "@/lib/docker/own-slot";

const { store, engine, streamed } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  streamed: [] as { id: string; line: string }[],
  engine: { run: null as null | ((id: string, opts: DeployOpts) => Promise<DeployResult>) },
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/redis", () => {
  const set = async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes("NX") && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  };
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set,
      del: async (k: string) => (store.delete(k) ? 1 : 0),
      pipeline: () => {
        const ops: (() => Promise<unknown>)[] = [];
        const p = { set: (k: string, v: string, ...a: unknown[]) => (ops.push(() => set(k, v, ...a)), p), exec: () => Promise.all(ops.map((o) => o())) };
        return p;
      },
      xadd: async () => "1-0",
      pexpire: async () => 1,
    },
  };
});
vi.mock("@/lib/docker/deploy", () => ({
  runDeployment: (id: string, opts: DeployOpts) => engine.run!(id, opts),
  stopProject: vi.fn(async () => ({ success: true, log: "" })),
}));
vi.mock("@/lib/docker/rollback-monitor", () => ({
  performRollback: vi.fn(),
  sendRollbackNotification: vi.fn(),
  slotContainerIds: vi.fn(async () => null),
  slotIsDown: vi.fn(async () => null),
}));
vi.mock("@/lib/docker/own-slot", () => ({ ownSlot: vi.fn(async () => "green") }));
vi.mock("@/lib/git-integration/github-feedback", () => ({
  trackDeploy: () => ({ queued: vi.fn(), stage: vi.fn(), finish: vi.fn() }),
  deployTimedOut: vi.fn(async () => {}),
  queuedDeployCancelled: vi.fn(async () => {}),
}));
vi.mock("@/lib/stream/producer", () => ({
  addEvent: vi.fn(async () => "1-0"),
  addDeployLog: vi.fn(async (id: string, entry: { line: string }) => (streamed.push({ id, line: entry.line }), "1-0")),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/incidents/deploy", () => ({ deployIncident: vi.fn(async () => null) }));

const conn = await connectScratchServer();

type Trigger = "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";

/** A stand-in engine run the test steps through stages and ends. */
type FakeRun = {
  opts: DeployOpts;
  enter: (stage: "clone" | "compose" | "build" | "deploy" | "healthcheck") => void;
  succeed: () => Promise<void>;
  done: Promise<DeployResult>;
};

describe.skipIf(!conn)("deploy executor on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deployexec");
  let sql: ReturnType<typeof postgres>;
  let q: typeof import("@/lib/deploy/queue");
  let exec: typeof import("@/lib/deploy/executor");
  let claim: typeof import("@/lib/deploy/claim-loop");
  let sweeper: typeof import("@/lib/deploy/sweeper");
  let gate: typeof import("@/lib/deploy/swap-gate");
  const runs = new Map<string, FakeRun>();

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('o1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'o1', 'proj', 'Proj')`;
    for (const id of ["a1", "a2", "a3"]) {
      await sql`insert into app (id, organization_id, project_id, name, display_name) values (${id}, 'o1', 'p1', ${`shop-${id}`}, ${id})`;
    }
    await sql`insert into app (id, organization_id, project_id, name, display_name) values ('self', 'o1', 'p1', 'vardo', 'Vardo')`;

    engine.run = (id, opts) => {
      let resolve!: (r: DeployResult) => void;
      const done = new Promise<DeployResult>((r) => (resolve = r));
      const end = (r: Omit<DeployResult, "deploymentId" | "log" | "durationMs">) => resolve({ deploymentId: id, log: "", durationMs: 1, ...r });
      const close = (status: string, supersededBy: string | null = null) =>
        sql`update deployment set status = ${status}, superseded_by = ${supersededBy}, finished_at = now()
            where id = ${id} and status = 'running' and claimed_by = ${opts.executorId!}`;
      opts.signal!.addEventListener("abort", async () => {
        const reason = opts.signal!.reason as { superseded?: true; supersededBy?: string; killed?: true; lost?: true };
        if (reason.lost) return end({ success: false, status: "cancelled", closedElsewhere: true });
        if (reason.superseded) {
          await close("superseded", reason.supersededBy ?? null);
          return end({ success: false, status: "superseded" });
        }
        await close("cancelled");
        end({ success: false, status: "cancelled" });
      });
      runs.set(id, {
        opts,
        enter: (stage) => opts.onStage!(stage, "running"),
        succeed: async () => {
          await sql`update deployment set status = 'success', slot = 'green', finished_at = now()
                    where id = ${id} and status = 'running' and claimed_by = ${opts.executorId!}`;
          end({ success: true, status: "success" });
        },
        done,
      });
      return done;
    };

    q = await import("@/lib/deploy/queue");
    exec = await import("@/lib/deploy/executor");
    claim = await import("@/lib/deploy/claim-loop");
    sweeper = await import("@/lib/deploy/sweeper");
    gate = await import("@/lib/deploy/swap-gate");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await exec?.resetExecutorForTests();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    for (const run of runs.values()) {
      if (!run.opts.signal?.aborted) await run.succeed().catch(() => {});
    }
    await exec.resetExecutorForTests();
    runs.clear();
    store.clear();
    await sql`delete from deployment`;
    await sql`delete from worker_job`;
  });

  async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const row = async (id: string) =>
    (await sql`select status, stage, attempts, claimed_by, scope_key, superseded_by, cancel_reason, log, request, exclusive_requested_at
               from deployment where id = ${id}`)[0];

  async function enqueue(appId: string, trigger: Trigger, extra: Partial<import("@/lib/deploy/queue").EnqueueOpts> = {}) {
    return (await q.enqueueDeploy({ appId, trigger, ...extra })).id;
  }

  /** Claims every claimable row in this process and waits for the stand-in to start each. */
  async function claimAll(scope: "all" | "self" | "others" = "all") {
    const ids = await claim.claimPass(scope);
    for (const id of ids) await until(() => runs.has(id), Boolean);
    return ids;
  }

  async function enter(id: string, stage: Parameters<FakeRun["enter"]>[0]) {
    runs.get(id)!.enter(stage);
    await until(() => row(id), (r) => r.stage === stage);
  }

  describe("cancel and supersede", () => {
    it("a manual deploy queues behind a running automatic build and never aborts it", async () => {
      const push = await enqueue("a1", "webhook");
      await claimAll();
      await enter(push, "build");

      const manual = await enqueue("a1", "manual");
      await exec.renewNowForTests();
      expect(runs.get(push)!.opts.signal!.aborted).toBe(false);
      expect((await row(push)).cancel_reason).toBeNull();
      expect((await row(manual)).status).toBe("queued");

      // Claimed next for the scope once the build ends.
      await runs.get(push)!.succeed();
      await until(() => claimAll(), (ids) => ids.includes(manual));
    });

    it("a newer push stops a running push's build and names the queued successor", async () => {
      const first = await enqueue("a1", "webhook");
      await claimAll();
      await enter(first, "build");

      const second = await enqueue("a1", "webhook");
      await exec.renewNowForTests();
      const result = await runs.get(first)!.done;
      expect(result.status).toBe("superseded");
      expect(await row(first)).toMatchObject({ status: "superseded", superseded_by: second });
      await until(() => claimAll(), (ids) => ids.includes(second));
    });

    it("a push never stops a build that reached the swap", async () => {
      const first = await enqueue("a1", "webhook");
      await claimAll();
      await enter(first, "build");
      await enter(first, "deploy");
      await enqueue("a1", "webhook");
      await exec.renewNowForTests();
      expect(runs.get(first)!.opts.signal!.aborted).toBe(false);
    });

    it("a user cancel aborts a build at the next renewal and waits for the boundary in the swap", async () => {
      const building = await enqueue("a1", "manual");
      const swapping = await enqueue("a2", "manual");
      await claimAll();
      await enter(building, "build");
      await enter(swapping, "build");
      await enter(swapping, "deploy");

      expect(await q.requestCancel(building, "user")).toBe("requested");
      expect(await q.requestCancel(swapping, "user")).toBe("requested");
      await exec.renewNowForTests();
      expect((await runs.get(building)!.done).status).toBe("cancelled");
      expect(runs.get(swapping)!.opts.signal!.aborted).toBe(false);

      // The next stage boundary reads the request.
      runs.get(swapping)!.enter("healthcheck");
      expect((await runs.get(swapping)!.done).status).toBe("cancelled");
    });

    it("a cancelled queued deploy is never claimed", async () => {
      const id = await enqueue("a1", "manual");
      expect(await q.requestCancel(id, "user")).toBe("cancelled");
      expect(await claimAll()).toEqual([]);
      const [{ statuses }] = await sql`select array_agg(status) as statuses from deployment where id = ${id}`;
      expect(statuses).toEqual(["cancelled"]);
    });

    it("a lost claim stops a build and the fence refuses the swap", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      await enter(id, "build");
      expect(await runs.get(id)!.opts.fence!()).toBe(true);

      await sql`update deployment set claimed_by = 'another-executor' where id = ${id}`;
      expect(await runs.get(id)!.opts.fence!()).toBe(false);
      await exec.renewNowForTests();
      expect((await runs.get(id)!.done).closedElsewhere).toBe(true);
    });
  });

  describe("claim scope", () => {
    it("the console claims only Vardo's own deploys, the worker everything else", async () => {
      const app = await enqueue("a1", "manual");
      const self = await enqueue("self", "api");
      expect(await claimAll("self")).toEqual([self]);
      expect(await claimAll("others")).toEqual([app]);
    });

    it("the escape hatch makes the console claim everything and the worker nothing", async () => {
      const { claimScope } = await import("@/lib/deploy/claim-scope");
      const env = { NODE_ENV: "production", VARDO_DEPLOY_EXECUTOR: "web" } as NodeJS.ProcessEnv;
      expect(claimScope("web", env)).toBe("all");
      expect(claimScope("worker", env)).toBe("none");
      expect(claimScope("web", { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("self");
      expect(claimScope("worker", { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("others");
      expect(await claim.claimPass("none")).toEqual([]);
    });
  });

  describe("crash rule", () => {
    const expire = (id: string) => sql`update deployment set lease_expires_at = now() - interval '1 second' where id = ${id}`;

    it("requeues a deploy whose executor died in the build once, then fails it", async () => {
      const id = await enqueue("a1", "webhook");
      await claimAll();
      await enter(id, "build");
      await expire(id);

      await sweeper.sweepExpiredLeases();
      const requeued = await row(id);
      expect(requeued).toMatchObject({ status: "queued", attempts: 1, claimed_by: null, stage: null });
      expect(requeued.log).toMatch(/Requeued: the executor running it stopped during build/);
      expect(streamed.filter((e) => e.id === id).map((e) => e.line)).toEqual([expect.stringMatching(/Requeued: the executor running it stopped during build/)]);

      // The executor that lost it stops, as a live one would on its next renewal.
      await exec.renewNowForTests();
      expect((await runs.get(id)!.done).closedElsewhere).toBe(true);
      await until(() => exec.runningHere(), (ids) => !ids.includes(id));
      runs.delete(id);
      expect(await claimAll()).toEqual([id]);
      await enter(id, "compose");
      await expire(id);
      await sweeper.sweepExpiredLeases();
      const failed = await row(id);
      expect(failed.status).toBe("failed");
      expect(failed.log).toMatch(/ERROR: The executor stopped during compose again, after one rerun/);
      expect(streamed.filter((e) => e.id === id).at(-1)?.line).toMatch(/ERROR: The executor stopped during compose again/);
    });

    it("requeues a deploy whose executor died before its first stage without using up the rerun", async () => {
      const id = await enqueue("a1", "manual");
      await sql`update deployment set status = 'running', claimed_by = 'gone', lease_expires_at = now() - interval '1 second' where id = ${id}`;
      await sweeper.sweepExpiredLeases();
      const requeued = await row(id);
      expect(requeued).toMatchObject({ status: "queued", attempts: 0, claimed_by: null });
      expect(requeued.log).toMatch(/Requeued: the executor that claimed it stopped before it started/);
    });

    it("a fence that passed records the swap, so a lapse after it fails the deploy instead of rerunning it", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      await enter(id, "build");
      expect(await runs.get(id)!.opts.fence!()).toBe(true);
      expect((await row(id)).stage).toBe("deploy");
      await expire(id);
      await sweeper.sweepExpiredLeases();
      expect(await row(id)).toMatchObject({ status: "failed", attempts: 0 });
    });

    it("fails a deploy whose executor died in the swap without a rerun", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      await enter(id, "build");
      await enter(id, "deploy");
      await expire(id);
      await sweeper.sweepExpiredLeases();
      expect(await row(id)).toMatchObject({ status: "failed", attempts: 0 });
    });

    it("leaves a deploy whose lease is current", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      await enter(id, "build");
      await sweeper.sweepExpiredLeases();
      expect((await row(id)).status).toBe("running");
    });

    it("fails a pre-queue running row only once its process's liveness key is gone", async () => {
      await sql`insert into deployment (id, app_id, trigger, status, started_at) values ('old-run', 'a1', 'manual', 'running', now() - interval '5 minutes')`;
      store.set("deploy:worker:old-run", "1");
      await sweeper.sweepExpiredLeases();
      expect((await row("old-run")).status).toBe("running");
      store.delete("deploy:worker:old-run");
      await sweeper.sweepExpiredLeases();
      expect((await row("old-run")).status).toBe("failed");
    });
  });

  describe("keys the pre-queue sweeper reads", () => {
    it("names a running deploy in its scope's active key until it ends, and leases this code's queued rows", async () => {
      const compat = await import("@/lib/deploy/legacy-compat");
      const id = await enqueue("a1", "manual");
      const held = (await q.enqueueDeploy({ appId: "a2", trigger: "api" }, { hold: true })).id;
      await sql`insert into deployment (id, app_id, trigger, status, started_at) values ('old-queued', 'a3', 'manual', 'queued', now())`;

      compat.resetLegacyCompatForTests();
      expect(await claimAll()).toEqual([id]);
      expect(store.get(`deploy:worker:${held}`)).toBe("1");
      // The old code leases its own rows.
      expect(store.has("deploy:worker:old-queued")).toBe(false);

      await until(() => store.get("deploy:active:a1"), Boolean);
      await enter(id, "build");
      await exec.renewNowForTests();
      expect(JSON.parse(store.get("deploy:active:a1")!)).toEqual({ deploymentId: id, stage: "build" });

      await runs.get(id)!.succeed();
      await until(() => exec.runningHere(), (ids) => !ids.includes(id));
      expect(store.has("deploy:active:a1")).toBe(false);
    });

    it("leaves a scope's active key that names another deploy", async () => {
      const compat = await import("@/lib/deploy/legacy-compat");
      store.set("deploy:active:a1", JSON.stringify({ deploymentId: "old-run", stage: "build" }));
      await compat.clearRunningForOldSweeper({ id: "new-run", scopeKey: "a1" });
      expect(store.has("deploy:active:a1")).toBe(true);
    });
  });

  describe("queued rows", () => {
    it("rows the old code queued rejoin the queue as pushes, or are cancelled, once their process is gone", async () => {
      await sql`insert into deployment (id, app_id, trigger, status, started_at) values
        ('old-push', 'a1', 'webhook', 'queued', now() - interval '5 minutes'),
        ('old-manual', 'a2', 'manual', 'queued', now() - interval '5 minutes'),
        ('old-live', 'a3', 'manual', 'queued', now() - interval '5 minutes'),
        ('old-fresh', 'a3', 'webhook', 'queued', now())`;
      store.set("deploy:worker:old-live", "1");

      // Stranded: claims skip a row with no scope.
      expect(await claimAll()).toEqual([]);

      await sweeper.sweepQueuedDeployments();
      expect(await row("old-push")).toMatchObject({ status: "queued", scope_key: "a1" });
      expect((await row("old-manual")).status).toBe("cancelled");
      expect((await row("old-manual")).log).toMatch(/Queued before Vardo updated/);
      expect(await row("old-live")).toMatchObject({ status: "queued", scope_key: null });
      expect(await row("old-fresh")).toMatchObject({ status: "queued", scope_key: null });
      expect(await claimAll()).toEqual(["old-push"]);
    });

    it("cancels automatic deploys queued over a day and leaves explicit ones", async () => {
      await sql`insert into deployment (id, app_id, trigger, status, scope_key, started_at) values
        ('stale-push', 'a1', 'webhook', 'queued', 'a1', now() - interval '25 hours'),
        ('stale-manual', 'a2', 'manual', 'queued', 'a2', now() - interval '25 hours'),
        ('fresh-push', 'a3', 'poll', 'queued', 'a3', now() - interval '23 hours')`;
      await sweeper.sweepQueuedDeployments();
      expect((await row("stale-push")).status).toBe("cancelled");
      expect((await row("stale-push")).log).toMatch(/Still queued after 24 hours/);
      expect((await row("stale-manual")).status).toBe("queued");
      expect((await row("fresh-push")).status).toBe("queued");
    });

    it("a held deploy is claimed only after its release, and an abandoned one is cancelled", async () => {
      const { id } = await q.enqueueDeploy({ appId: "a1", trigger: "api" }, { hold: true });
      expect(await claimAll()).toEqual([]);
      await sweeper.sweepQueuedDeployments();
      expect((await row(id)).status).toBe("queued");

      expect(await q.releaseHeldDeploy(id)).toBe(true);
      expect(await row(id)).toMatchObject({ scope_key: "a1", request: null });
      expect(await claimAll()).toEqual([id]);

      const { id: abandoned } = await q.enqueueDeploy({ appId: "a2", trigger: "api" }, { hold: true });
      await sql`update deployment set started_at = now() - interval '16 minutes' where id = ${abandoned}`;
      await sweeper.sweepQueuedDeployments();
      expect((await row(abandoned)).status).toBe("cancelled");
    });
  });

  describe("time budget", () => {
    it("asks a deploy past the budget to stop with reason timeout", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      await enter(id, "build");
      store.set(`deploy:sweep:running-since:${id}`, String(Date.now() - 2 * 24 * 60 * 60_000));
      await sweeper.sweepStuckDeployments();
      expect((await row(id)).cancel_reason).toBe("timeout");
      await exec.renewNowForTests();
      expect((await runs.get(id)!.done).status).toBe("cancelled");
    });
  });

  describe("exclusive swaps", () => {
    // Room to claim, so only the flag holds claims back.
    beforeEach(() => void vi.stubEnv("VARDO_MAX_DEPLOY_CONCURRENCY", "4"));
    afterEach(() => void vi.unstubAllEnvs());

    const ctxFor = (id: string, lines: string[]) =>
      ({
        deploymentId: id,
        claimedBy: exec.executorId(),
        app: { name: "vardo" },
        envIsolated: false,
        log: (l: string) => lines.push(l),
      }) as unknown as import("@/lib/docker/deploy-context").DeployContext;

    it("Vardo's swap waits for running deploys, holds new claims meanwhile, then goes ahead", async () => {
      const app = await enqueue("a1", "manual");
      const self = await enqueue("self", "api");
      await claimAll();
      await enter(app, "build");

      const lines: string[] = [];
      const swap = gate.beforeSwap(ctxFor(self, lines), { noticeMs: 100 });
      await until(() => row(self), (r) => r.exclusive_requested_at !== null);

      // New claims wait while the flag is up.
      const queued = await enqueue("a2", "manual");
      expect(await claimAll()).toEqual([]);
      await new Promise((r) => setTimeout(r, 1_300));
      expect(lines.join("\n")).toMatch(/Waiting for 1 deploy to finish before the swap/);

      await runs.get(app)!.succeed();
      await swap;
      expect(lines.join("\n")).toMatch(/Other deploys finished after/);

      // A committed self-deploy keeps the flag until a claimer in the new slot clears it.
      await runs.get(self)!.succeed();
      await until(() => exec.runningHere(), (ids) => !ids.includes(self));
      expect((await row(self)).exclusive_requested_at).not.toBeNull();
      vi.mocked(ownSlot).mockResolvedValueOnce("blue");
      expect(await claimAll("others")).toEqual([]);
      expect((await row(self)).exclusive_requested_at).not.toBeNull();
      expect(await claimAll("others")).toEqual([queued]);
      expect((await row(self)).exclusive_requested_at).toBeNull();
    });

    it("the new slot's console clears a committed self-deploy's hold and claims the next one; the old slot's can't", async () => {
      await enqueue("self", "api");
      const [first] = await claimAll("self");
      await sql`update deployment set exclusive_requested_at = now() where id = ${first}`;
      await runs.get(first)!.succeed();
      await until(() => exec.runningHere(), (ids) => !ids.includes(first));
      expect((await row(first)).exclusive_requested_at).not.toBeNull();

      const fix = await enqueue("self", "api");
      vi.mocked(ownSlot).mockResolvedValueOnce("blue");
      expect(await claimAll("self")).toEqual([]);
      vi.mocked(ownSlot).mockResolvedValueOnce(null);
      expect(await claimAll("self")).toEqual([]);
      expect((await row(first)).exclusive_requested_at).not.toBeNull();

      expect(await claimAll("self")).toEqual([fix]);
      expect((await row(first)).exclusive_requested_at).toBeNull();
    });

    it("goes ahead at the cap with deploys still running", async () => {
      const app = await enqueue("a1", "manual");
      const self = await enqueue("self", "api");
      await claimAll();
      await enter(app, "build");
      const lines: string[] = [];
      await gate.beforeSwap(ctxFor(self, lines), { timeoutMs: 300, noticeMs: 100 });
      expect(lines.join("\n")).toMatch(/Swapping with 1 deploy still running/);
    });

    it("a flag older than 30 minutes stops blocking claims", async () => {
      await enqueue("self", "api");
      const [self] = await claimAll("self");
      await sql`update deployment set exclusive_requested_at = now() - interval '31 minutes' where id = ${self}`;
      const app = await enqueue("a1", "manual");
      expect(await claimAll("others")).toEqual([app]);
    });

    it("a failed self-deploy clears its flag", async () => {
      await enqueue("self", "api");
      const [self] = await claimAll("self");
      await sql`update deployment set exclusive_requested_at = now() where id = ${self}`;
      await q.requestCancel(self, "user");
      await exec.renewNowForTests();
      await until(() => exec.runningHere(), (ids) => !ids.includes(self));
      expect((await row(self)).exclusive_requested_at).toBeNull();
    });
  });

  describe("group jobs", () => {
    it("runs one group job per project and group environment at a time", async () => {
      const g = await import("@/lib/deploy/group-job");
      const a = await g.enqueueGroupDeploy({ projectId: "p1", organizationId: "o1", trigger: "manual" });
      const b = await g.enqueueGroupDeploy({ projectId: "p1", organizationId: "o1", trigger: "manual" });
      const c = await g.enqueueGroupDeploy({ projectId: "p1", organizationId: "o1", trigger: "manual", groupEnvironmentId: "ge1" });
      const claimed = (await g.claimGroupJobs("x", 4)).map((j) => j.id).sort();
      expect(claimed).toEqual([a, c].sort());
      expect(await g.claimGroupJobs("x", 4)).toEqual([]);
      await sql`update worker_job set status = 'success' where id = ${a}`;
      expect((await g.claimGroupJobs("x", 4)).map((j) => j.id)).toEqual([b]);
    });

    it("fails a group job whose executor stopped", async () => {
      const g = await import("@/lib/deploy/group-job");
      const id = await g.enqueueGroupDeploy({ projectId: "p1", organizationId: "o1", trigger: "manual" });
      await g.claimGroupJobs("x", 1);
      await sql`update worker_job set lease_expires_at = now() - interval '1 second' where id = ${id}`;
      await sweeper.sweepGroupJobs();
      const [job] = await sql`select status from worker_job where id = ${id}`;
      expect(job.status).toBe("failed");
    });
  });

  describe("drain", () => {
    it("stops claiming at once and waits for running deploys", async () => {
      const id = await enqueue("a1", "manual");
      await claimAll();
      const drained = exec.drainDeploys(5_000);
      await enqueue("a2", "manual");
      expect(await claim.claimPass("all")).toEqual([]);
      await runs.get(id)!.succeed();
      expect(await drained).toEqual([]);
    });
  });
});
