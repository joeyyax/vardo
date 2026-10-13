// 0129 on a scratch database: checked_at becomes timestamptz and existing values keep their UTC instant
// even when the migrating session runs in another zone. Skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0129_domain_check_timestamptz";
const conn = await connectScratchServer();

describe.skipIf(!conn)("0129 domain_check timestamptz, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0129");
  let sql: ReturnType<typeof postgres>;
  let before: string;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into domain_check (id, domain_id, reachable, checked_at) values ('k1', 'd1', true, '2026-10-10 12:00:00')`;
    });
    // The runner's session zone must not shift existing rows.
    await sql.unsafe(`alter database "${dbName}" set timezone to 'America/Los_Angeles'`);
    expect((await runMigrate(url)).code).toBe(0);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("reads existing values as UTC", async () => {
    const [row] = await sql<{ type: string; at: Date }[]>`
      select pg_typeof(checked_at)::text as type, checked_at as at from domain_check where id = 'k1'`;
    expect(row!.type).toBe("timestamp with time zone");
    expect(row!.at.toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });

  it("stamps new rows with the current instant outside UTC", async () => {
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`set local timezone to 'Asia/Tokyo'`;
      await t`insert into domain_check (id, domain_id, reachable) values ('k2', 'd1', true)`;
    });
    const [row] = await sql<{ at: Date }[]>`select checked_at as at from domain_check where id = 'k2'`;
    expect(Math.abs(row!.at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});
