// 0098 on a scratch database: existing jobs get their app's org, org-level URL jobs need no app,
// command jobs still do and deleting an app removes only its own jobs.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { DRIZZLE, MIGRATE_TIMEOUT, connectScratchServer, journal, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0098_org_cron";
const SQL_TEXT = readFileSync(join(DRIZZLE, `${TAG}.sql`), "utf8");

describe("0098 org cron migration, as text", () => {
  it("is in the journal at 98", () => {
    expect(journal.entries.find((e) => e.tag === TAG)?.idx).toBe(98);
  });

  it("backfills organization_id before making it required", () => {
    const add = SQL_TEXT.indexOf('ADD COLUMN "organization_id" text;');
    const fill = SQL_TEXT.indexOf('UPDATE "cron_job" SET "organization_id"');
    const required = SQL_TEXT.indexOf('ALTER COLUMN "organization_id" SET NOT NULL');
    expect(add).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(add);
    expect(required).toBeGreaterThan(fill);
  });
});

const conn = await connectScratchServer();

describe.skipIf(!conn)("0098 org cron migration, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0098");
  let sql: ReturnType<typeof postgres>;
  let before: string;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into organization (id, name, slug) values ('o1', 'Example', 'example')`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a1', 'o1', 'web', 'Web', 'p1')`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a2', 'o1', 'api', 'API', 'p1')`;
      await t`insert into cron_job (id, app_id, name, schedule, command) values ('c1', 'a1', 'cleanup', '0 * * * *', 'id')`;
      await t`insert into cron_job (id, app_id, name, type, schedule, command) values ('c2', 'a2', 'ping', 'url', '* * * * *', 'https://example.com')`;
    });
    expect((await runMigrate(url)).code).toBe(0);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("gives existing jobs their app's org and the URL defaults", async () => {
    const rows = await sql`select id, organization_id, method, timeout_ms, retries, expected_status, headers from cron_job order by id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: "c1", organization_id: "o1", method: "GET", timeout_ms: 30000, retries: 0, expected_status: null, headers: null },
      { id: "c2", organization_id: "o1", method: "GET", timeout_ms: 30000, retries: 0, expected_status: null, headers: null },
    ]);
  });

  it("takes an org-level URL job with no app", async () => {
    await sql`insert into cron_job (id, organization_id, name, type, schedule, command) values ('c3', 'o1', 'site', 'url', '*/10 * * * *', 'https://example.com/wp-cron.php')`;
    const [row] = await sql`select app_id from cron_job where id = 'c3'`;
    expect(row.app_id).toBeNull();
  });

  it("refuses a command job with no app", async () => {
    await expect(
      sql`insert into cron_job (id, organization_id, name, type, schedule, command) values ('c4', 'o1', 'bad', 'command', '* * * * *', 'id')`,
    ).rejects.toThrow(/cron_job_command_needs_app/);
  });

  it("requires an org", async () => {
    await expect(
      sql`insert into cron_job (id, name, type, schedule, command) values ('c5', 'orphan', 'url', '* * * * *', 'https://example.com')`,
    ).rejects.toThrow(/organization_id/);
  });

  it("stores run details", async () => {
    await sql`insert into cron_job_run (id, cron_job_id, status, started_at, http_status, duration_ms, attempts) values ('r1', 'c3', 'success', now(), 200, 42, 2)`;
    const [run] = await sql`select http_status, duration_ms, attempts from cron_job_run where id = 'r1'`;
    expect({ ...run }).toEqual({ http_status: 200, duration_ms: 42, attempts: 2 });
  });

  it("deletes only an app's own jobs with the app", async () => {
    await sql`delete from app where id = 'a1'`;
    const rows = await sql`select id from cron_job order by id`;
    expect(rows.map((r) => r.id)).toEqual(["c2", "c3"]);
  });
});
