// 0162 on a scratch database: every existing organization gets its own log account, and new ones get the next.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, journal, projectBefore, runMigrate, scratchName } from "./scratch-db";

const TAG = "0162_org_log_account";
const conn = await connectScratchServer();

describe.skipIf(!conn)("0162 org log account migration, on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("0162");
  let sql: ReturnType<typeof postgres>;
  let before: string;
  let applied: { code: number; out: string };

  beforeAll(async () => {
    expect(journal.entries.find((e) => e.tag === TAG)?.idx).toBe(162);
    const url = await conn!.create(dbName);
    before = projectBefore(TAG);
    expect((await runMigrate(url, before)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('vardo', 'Vardo', 'vardo'), ('o1', 'One', 'one'), ('o2', 'Two', 'two')`;
    applied = await runMigrate(url);
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("gives every existing organization a distinct account above the unassigned tenant", async () => {
    expect(applied.code).toBe(0);
    const rows = await sql`select id, log_account_id from organization`;
    const ids = rows.map((r) => r.log_account_id as number);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
  });

  it("assigns the next account to an organization created after it, without the code naming one", async () => {
    await sql`insert into organization (id, name, slug) values ('o3', 'Three', 'three')`;
    const [{ max }] = await sql`select max(log_account_id) as max from organization where id <> 'o3'`;
    const [created] = await sql`select log_account_id from organization where id = 'o3'`;
    expect(created.log_account_id).toBeGreaterThan(max);
  });

  it("refuses two organizations on one account", async () => {
    const [{ log_account_id: taken }] = await sql`select log_account_id from organization where id = 'o1'`;
    await expect(sql`update organization set log_account_id = ${taken} where id = 'o2'`).rejects.toThrow(/organization_log_account_id_unique/);
  });

  it("never hands a deleted organization's account to a new one", async () => {
    const [{ log_account_id: gone }] = await sql`delete from organization where id = 'o3' returning log_account_id`;
    await sql`insert into organization (id, name, slug) values ('o4', 'Four', 'four')`;
    const [created] = await sql`select log_account_id from organization where id = 'o4'`;
    expect(created.log_account_id).toBeGreaterThan(gone);
  });
});
