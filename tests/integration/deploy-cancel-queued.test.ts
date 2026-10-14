// Cancelling a queued deploy against a scratch Postgres.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: vi.fn(async () => ({})) }));
vi.mock("@/lib/redis", () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  },
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn(async () => true),
  waitForConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(async () => {}),
  removeFromQueue: vi.fn(async () => {}),
  getConcurrencyLimit: () => 4,
}));
vi.mock("@/lib/git-integration/github-feedback", () => ({
  trackDeploy: () => ({ queued: vi.fn(), stage: vi.fn(), finish: vi.fn() }),
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn(async () => "1-0") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/docker/deploy-logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/deploy-logger")>()),
  createDeployLogger: () => ({
    addSecrets: vi.fn(), addPublicNames: vi.fn(),
    redact: (text: string) => text,
    log: (line: string) => line,
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));

const conn = await connectScratchServer();

describe.skipIf(!conn)("cancelling a queued deploy on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deploy_cancel");
  let sql: ReturnType<typeof postgres>;
  let cancel: typeof import("@/lib/docker/deploy-cancel");
  let route: typeof import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/route");
  let db: typeof import("@/lib/db").db;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'org1', 'proj', 'Proj')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name) values ('app1', 'org1', 'p1', 'one', 'One')`;
    // Every status a deployment row takes, in order.
    await sql`create table status_seen (deployment_id text, status text, seq serial)`;
    await sql.unsafe(`
      create function note_status() returns trigger language plpgsql as $$
      begin insert into status_seen (deployment_id, status) values (new.id, new.status::text); return new; end $$;
      create trigger note_status after insert or update of status on deployment for each row execute function note_status();
    `);
    cancel = await import("@/lib/docker/deploy-cancel");
    route = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/route");
    db = (await import("@/lib/db")).db;
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    store.clear();
    await sql`delete from deployment`;
    await sql`delete from status_seen`;
  });

  const seen = async (id: string) =>
    (await sql`select status from status_seen where deployment_id = ${id} order by seq`).map((r) => r.status);

  const del = (deploymentId: string) =>
    route.DELETE(
      jsonRequest("DELETE", `/api/v1/organizations/org1/apps/app1/deployments/${deploymentId}`),
      routeCtx({ orgId: "org1", appId: "app1", deploymentId }),
    );

  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("a deploy cancelled while parked on a busy scope never reaches running", async () => {
    store.set("deploy:active:app1", JSON.stringify({ deploymentId: "other", stage: "swap" }));
    const lines: string[] = [];
    const run = cancel.requestDeploy({ appId: "app1", organizationId: "org1", trigger: "manual", onLog: (l) => lines.push(l) });
    await until(() => lines.some((l) => l.includes("Waiting for the deploy already running")));

    const [{ id }] = await sql`select id from deployment where app_id = 'app1'`;
    const res = await del(id);
    expect(res.status).toBe(200);

    store.delete("deploy:active:app1");
    const result = await run;

    expect(result.status).toBe("cancelled");
    expect(await seen(id)).toEqual(["queued", "cancelled"]);
  });

  it("a cancel that loses the race to the start leaves the running row and signals the kill", async () => {
    const [{ id }] = await sql`insert into deployment (id, app_id, status, trigger) values ('dep-race', 'app1', 'queued', 'manual') returning id`;
    const findFirst = db.query.deployments.findFirst.bind(db.query.deployments);
    const spy = vi.spyOn(db.query.deployments, "findFirst").mockImplementationOnce((async (args: Parameters<typeof findFirst>[0]) => {
      const row = await findFirst(args);
      // The engine claims the row between the route's read and its write.
      await sql`update deployment set status = 'running' where id = ${id}`;
      return row;
    }) as typeof findFirst);

    const res = await del(id);
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(await seen(id)).toEqual(["queued", "running"]);
    expect(store.has(`deploy:kill:${id}`)).toBe(true);
  });
});
