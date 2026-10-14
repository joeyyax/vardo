// 0132 on a scratch database: legacy running rows survive the one-running-per-scope index.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, journal, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0132_deploy_queue";
const conn = await connectScratchServer();

describe.skipIf(!conn)("0132 deploy queue migration, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0132");
  let sql: ReturnType<typeof postgres>;
  let before: string;
  let applied: { code: number; out: string };

  beforeAll(async () => {
    expect(journal.entries.find((e) => e.tag === TAG)?.idx).toBe(132);
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a1', 'o1', 'web', 'Web', 'p1')`;
      // Two running rows on one app, as a crashed process can leave behind.
      await t`insert into deployment (id, app_id, trigger, status) values ('d1', 'a1', 'manual', 'running'), ('d2', 'a1', 'webhook', 'running'), ('d3', 'a1', 'poll', 'queued')`;
    });
    applied = await runMigrate(url);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("applies over two running rows in one app and leaves them unscoped", async () => {
    expect(applied.code).toBe(0);
    const rows = await sql`select id, status, scope_key, attempts from deployment order by id`;
    expect(rows.map((r) => [r.id, r.status, r.scope_key, r.attempts])).toEqual([
      ["d1", "running", null, 0],
      ["d2", "running", null, 0],
      ["d3", "queued", null, 0],
    ]);
  });

  it("allows one running row per scope once rows carry a scope", async () => {
    await sql`update deployment set scope_key = 'a1' where id = 'd1'`;
    await expect(sql`update deployment set scope_key = 'a1' where id = 'd2'`).rejects.toThrow(/deployment_scope_running_uniq/);
    // A finished row frees the scope.
    await sql`update deployment set status = 'success' where id = 'd1'`;
    await sql`update deployment set scope_key = 'a1' where id = 'd2'`;
  });

  it("creates worker_job", async () => {
    await sql`insert into worker_job (id, kind, request) values ('j1', 'deploy-group', '{}')`;
    const [job] = await sql`select status, attempts from worker_job where id = 'j1'`;
    expect(job).toEqual({ status: "queued", attempts: 0 });
  });
});
