// Cancelling a queued deploy through the API, against a scratch Postgres.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: vi.fn(async () => ({})) }));

const conn = await connectScratchServer();

describe.skipIf(!conn)("cancelling a queued deploy on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deploy_cancel");
  let sql: ReturnType<typeof postgres>;
  let q: typeof import("@/lib/deploy/queue");
  let route: typeof import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/route");
  let db: typeof import("@/lib/db").db;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
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
    q = await import("@/lib/deploy/queue");
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

  it("a deploy cancelled while it waits behind a running one never reaches running", async () => {
    const busy = await q.enqueueDeploy({ appId: "app1", trigger: "manual" });
    await q.claimDeploys("exec-1");
    const { id } = await q.enqueueDeploy({ appId: "app1", trigger: "manual" });

    const res = await del(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await sql`update deployment set status = 'success' where id = ${busy.id}`;
    expect(await q.claimDeploys("exec-1")).toEqual([]);
    expect(await seen(id)).toEqual(["queued", "cancelled"]);
  });

  it("a cancel that loses the race to a claim flags the running row for its executor", async () => {
    const { id } = await q.enqueueDeploy({ appId: "app1", trigger: "manual" });
    const findFirst = db.query.deployments.findFirst.bind(db.query.deployments);
    const spy = vi.spyOn(db.query.deployments, "findFirst").mockImplementationOnce((async (args: Parameters<typeof findFirst>[0]) => {
      const row = await findFirst(args);
      // An executor claims the row between the route's read and its write.
      await q.claimDeploys("exec-1");
      return row;
    }) as typeof findFirst);

    const res = await del(id);
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelling: true });
    expect(await seen(id)).toEqual(["queued", "running"]);
    const [row] = await sql`select cancel_reason from deployment where id = ${id}`;
    expect(row.cancel_reason).toBe("user");
  });

  it("a finished deployment can't be cancelled", async () => {
    const { id } = await q.enqueueDeploy({ appId: "app1", trigger: "manual" });
    await sql`update deployment set status = 'success' where id = ${id}`;
    expect((await del(id)).status).toBe(409);
  });
});
