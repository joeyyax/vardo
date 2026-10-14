// Deploys queue per app environment, against a scratch Postgres. The engine is a stand-in.
// The scope was once the app alone, so a pr-24 preview deploy superseded a production merge deploy nine seconds in.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../../drizzle/scratch-db";
import type { DeployOpts, DeployResult } from "@/lib/docker/deploy";

const { engine } = vi.hoisted(() => ({ engine: { run: null as null | ((id: string, opts: DeployOpts) => Promise<DeployResult>) } }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/redis", () => ({ redis: { pipeline: () => ({ set() { return this; }, exec: async () => [] }), del: async () => 0 } }));
vi.mock("@/lib/docker/deploy", () => ({ runDeployment: (id: string, opts: DeployOpts) => engine.run!(id, opts) }));
vi.mock("@/lib/git-integration/github-feedback", () => ({ trackDeploy: () => ({ queued: vi.fn(), stage: vi.fn(), finish: vi.fn() }) }));

const conn = await connectScratchServer();

describe.skipIf(!conn)("deploy scope per environment", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deployscope");
  let sql: ReturnType<typeof postgres>;
  let q: typeof import("@/lib/deploy/queue");
  let exec: typeof import("@/lib/deploy/executor");
  const runs = new Map<string, { signal: AbortSignal; finish: () => Promise<void> }>();

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org-1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'org-1', 'proj', 'Proj')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name) values ('app-1', 'org-1', 'p1', 'notes-api', 'Notes')`;
    await sql`insert into environment (id, app_id, name, is_default) values ('env-prod', 'app-1', 'production', true), ('env-pr-ab', 'app-1', 'pr-24', false)`;

    engine.run = (id, opts) =>
      new Promise((resolve) => {
        const close = async (status: string) => {
          await sql`update deployment set status = ${status}, finished_at = now() where id = ${id} and claimed_by = ${opts.executorId!} and status = 'running'`;
          resolve({ deploymentId: id, success: status === "success", log: "", durationMs: 1, status: status as DeployResult["status"] });
        };
        opts.signal!.addEventListener("abort", () => void close("superseded"));
        runs.set(id, { signal: opts.signal!, finish: () => close("success") });
        opts.onStage!("build", "running");
      });

    q = await import("@/lib/deploy/queue");
    exec = await import("@/lib/deploy/executor");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await exec?.resetExecutorForTests();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    for (const run of runs.values()) if (!run.signal.aborted) await run.finish();
    await exec.resetExecutorForTests();
    runs.clear();
    await sql`delete from deployment`;
  });

  async function waitFor(check: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Claims what's claimable and starts it on the stand-in, as the claim loop does. */
  async function claimAndStart(): Promise<string[]> {
    const rows = await q.claimDeploys(exec.executorId());
    for (const row of rows) void exec.startClaimed(row);
    for (const row of rows) await waitFor(() => runs.has(row.id));
    // Each run records its build stage before the test acts on it.
    for (const row of rows) await waitFor(async () => (await sql`select stage from deployment where id = ${row.id}`)[0].stage === "build");
    return rows.map((r) => r.id);
  }

  it("a preview deploy runs alongside a production deploy of the same app", async () => {
    const production = await q.enqueueDeploy({ appId: "app-1", trigger: "webhook" });
    const preview = await q.enqueueDeploy({ appId: "app-1", trigger: "webhook", environmentId: "env-pr-ab" });
    expect(production.scopeKey).toBe("app-1");
    expect(preview.scopeKey).toBe("app-1:env-pr-ab");
    expect(preview.cancelRequested).toEqual([]);

    expect((await claimAndStart()).sort()).toEqual([production.id, preview.id].sort());
    await exec.renewNowForTests();
    expect(runs.get(production.id)!.signal.aborted).toBe(false);
  });

  it("the default environment's id resolves to the app's own scope", async () => {
    expect((await q.enqueueDeploy({ appId: "app-1", trigger: "manual", environmentId: "env-prod" })).scopeKey).toBe("app-1");
  });

  it("a manual production deploy never aborts the production build already running; it runs next", async () => {
    const push = await q.enqueueDeploy({ appId: "app-1", trigger: "webhook" });
    expect(await claimAndStart()).toEqual([push.id]);

    const manual = await q.enqueueDeploy({ appId: "app-1", trigger: "manual", environmentId: "env-prod" });
    expect(manual.cancelRequested).toEqual([]);
    await exec.renewNowForTests();
    expect(runs.get(push.id)!.signal.aborted).toBe(false);
    const [running] = await sql`select status, cancel_requested_at from deployment where id = ${push.id}`;
    expect(running).toMatchObject({ status: "running", cancel_requested_at: null });

    expect(await claimAndStart()).toEqual([]);
    await runs.get(push.id)!.finish();
    await waitFor(() => !exec.runningHere().includes(push.id));
    expect(await claimAndStart()).toEqual([manual.id]);
  });

  it("a newer push still stops a production build in progress", async () => {
    const first = await q.enqueueDeploy({ appId: "app-1", trigger: "webhook" });
    await claimAndStart();
    await q.enqueueDeploy({ appId: "app-1", trigger: "webhook", environmentId: "env-prod" });
    await exec.renewNowForTests();
    await waitFor(() => runs.get(first.id)!.signal.aborted);
  });
});
