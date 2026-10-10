// 0088 on a scratch database: migrate to 0087, seed rows, apply 0088 and check the new columns.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { DRIZZLE, MIGRATE_TIMEOUT, connectScratchServer, journal, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0088_build_plan";
const SQL_TEXT = readFileSync(join(DRIZZLE, `${TAG}.sql`), "utf8");

describe("0088 build plan migration, as text", () => {
  it("is in the journal at 88", () => {
    expect(journal.entries.find((e) => e.tag === TAG)?.idx).toBe(88);
  });

  it("only adds nullable columns with no default, so existing apps keep auto-detection", () => {
    const statements = SQL_TEXT.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "app" ADD COLUMN "build_command" text;',
      'ALTER TABLE "app" ADD COLUMN "start_command" text;',
      'ALTER TABLE "app" ADD COLUMN "build_provider" text;',
      'ALTER TABLE "deployment" ADD COLUMN "build_plan" jsonb;',
    ]);
  });
});

const conn = await connectScratchServer();

describe.skipIf(!conn)("0088 build plan migration, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0088");
  let sql: ReturnType<typeof postgres>;
  let before: string;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a1', 'o1', 'web', 'Web', 'p1')`;
      await t`insert into deployment (id, app_id, trigger) values ('d1', 'a1', 'manual')`;
    });
    expect((await runMigrate(url)).code).toBe(0);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("adds the columns nullable, with the declared types", async () => {
    const rows = await sql`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where (table_name = 'app' and column_name in ('build_command', 'start_command', 'build_provider'))
         or (table_name = 'deployment' and column_name = 'build_plan')
      order by table_name, column_name`;
    expect(rows.map((r) => [r.table_name, r.column_name, r.data_type, r.is_nullable, r.column_default])).toEqual([
      ["app", "build_command", "text", "YES", null],
      ["app", "build_provider", "text", "YES", null],
      ["app", "start_command", "text", "YES", null],
      ["deployment", "build_plan", "jsonb", "YES", null],
    ]);
  });

  it("leaves existing apps on auto-detection and existing deploys without a plan", async () => {
    const [app] = await sql`select build_command, start_command, build_provider from app where id = 'a1'`;
    expect(app).toEqual({ build_command: null, start_command: null, build_provider: null });
    const [dep] = await sql`select build_plan from deployment where id = 'd1'`;
    expect(dep.build_plan).toBeNull();
  });

  it("stores and returns a plan record", async () => {
    const record = { engine: "nixpacks", version: null, summary: { providers: ["node"] }, plan: { phases: {} } };
    await sql`update deployment set build_plan = ${sql.json(record)} where id = 'd1'`;
    const [dep] = await sql`select build_plan from deployment where id = 'd1'`;
    expect(dep.build_plan).toEqual(record);
  });
});
