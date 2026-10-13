// 0128 on a scratch database: hourly rows the raw store still holds are cleared and the rollup re-rolls them.
// Skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0128_rollup_production_only";
const HOUR = 60 * 60_000;
const conn = await connectScratchServer();

describe.skipIf(!conn)("0128 rollup rebuild, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0128");
  let sql: ReturnType<typeof postgres>;
  let before: string;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const now = Date.now();
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into app_metric_hour (app_id, organization_id, hour) values
        ('a1', 'o1', ${new Date(now - 8 * 24 * HOUR)}),
        ('a1', 'o1', ${new Date(now - 2 * HOUR)})`;
      await t`insert into system_settings (key, value) values
        ('metrics-rollup:rolled-until', ${new Date(now).toISOString()}),
        ('other', 'kept')`;
    });
    expect((await runMigrate(url)).code).toBe(0);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("clears rows inside the raw window and keeps older ones it can't rebuild", async () => {
    const rows = await sql<{ hour: Date }[]>`select hour from app_metric_hour`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hour.getTime()).toBeLessThan(Date.now() - 7 * 24 * HOUR);
  });

  it("resets the watermark so the next pass re-rolls the window", async () => {
    const keys = (await sql<{ key: string }[]>`select key from system_settings order by key`).map((r) => r.key);
    expect(keys).toEqual(["other"]);
  });
});
