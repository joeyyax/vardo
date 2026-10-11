// The user_star migration: one target per star, unique per user, removed with its user, org, project or app.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { DRIZZLE, MIGRATE_TIMEOUT, connectScratchServer, journal, runMigrate, scratchName } from "./scratch-db";

const entry = journal.entries.find((e) => readFileSync(join(DRIZZLE, `${e.tag}.sql`), "utf8").includes('CREATE TABLE "user_star"'));
const SQL_TEXT = entry ? readFileSync(join(DRIZZLE, `${entry.tag}.sql`), "utf8") : "";

describe("user_star migration, as text", () => {
  it("creates the table once", () => {
    expect(entry).toBeDefined();
  });

  it.each(["user", "organization", "project", "app"])("cascades from %s", (table) => {
    expect(SQL_TEXT).toMatch(new RegExp(`REFERENCES "public"\\."${table}"\\("id"\\) ON DELETE cascade`));
  });
});

const conn = await connectScratchServer();

describe.skipIf(!conn)("user_star on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("user-star");
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('o1', 'Example', 'example')`;
    await sql`insert into "user" (id, email) values ('u1', 'one@example.com'), ('u2', 'two@example.com')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'o1', 'web', 'Web'), ('p2', 'o1', 'api', 'API')`;
    await sql`insert into app (id, organization_id, name, display_name, project_id) values ('a1', 'o1', 'site', 'Site', 'p1'), ('a2', 'o1', 'worker', 'Worker', 'p2')`;
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  const star = (id: string, user: string, kind: string, project: string | null, app: string | null) =>
    sql`insert into user_star (id, user_id, organization_id, kind, project_id, app_id) values (${id}, ${user}, 'o1', ${kind}, ${project}, ${app})`;
  const ids = async () => (await sql`select id from user_star order by id`).map((r) => r.id);

  it("refuses a star with no target or two", async () => {
    await expect(star("bad1", "u1", "project", null, null)).rejects.toThrow(/user_star_one_target/);
    await expect(star("bad2", "u1", "app", "p1", "a1")).rejects.toThrow(/user_star_one_target/);
  });

  it("refuses a second star on the same target", async () => {
    await star("s1", "u1", "project", "p1", null);
    await expect(star("s1b", "u1", "project", "p1", null)).rejects.toThrow(/user_star_project_uniq/);
  });

  it("removes stars with their app, project and user", async () => {
    await star("s2", "u1", "app", null, "a1");
    await star("s3", "u2", "project", "p2", null);
    await star("s4", "u2", "app", null, "a2");
    expect(await ids()).toEqual(["s1", "s2", "s3", "s4"]);

    await sql`delete from app where id = 'a1'`;
    expect(await ids()).toEqual(["s1", "s3", "s4"]);

    await sql`delete from project where id = 'p1'`;
    expect(await ids()).toEqual(["s3", "s4"]);

    await sql`delete from "user" where id = 'u2'`;
    expect(await ids()).toEqual([]);
  });
});
