// Applies every migration in drizzle/ to a scratch database with the production
// runner (scripts/migrate.mjs) and checks the journal, the replay and the schema.
//
// Needs a Postgres it can create databases on. Point MIGRATE_TEST_ADMIN_URL (or
// DATABASE_URL, or a DATABASE_URL line in .env) at the dev container, e.g.
// postgresql://host:<password>@localhost:7100/postgres. Without one the
// database-backed tests skip; the journal checks always run. Takes about a second.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";
import { TOP_LEVEL_NAME_CONSTRAINT } from "@/lib/db/app-name";

const ROOT = process.cwd();
const DRIZZLE = join(ROOT, "drizzle");
const MIGRATE = join(ROOT, "scripts/migrate.mjs");

type Journal = { entries: { idx: number; tag: string; when: number }[] };
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as Journal;
const tags = journal.entries.map((e) => e.tag);

// SQL files the journal never lists: they run nowhere.
const KNOWN_ORPHANS = ["0028_require_project_id"];

describe("migration journal", () => {
  it("numbers its entries 0..n-1 without gaps", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("lists each tag once, and each tag's prefix matches its position", () => {
    expect(new Set(tags).size).toBe(tags.length);
    journal.entries.forEach((e) => expect(e.tag.slice(0, 4)).toBe(String(e.idx).padStart(4, "0")));
  });

  it("has a SQL file for every entry", () => {
    const files = new Set(readdirSync(DRIZZLE));
    expect(tags.filter((t) => !files.has(`${t}.sql`))).toEqual([]);
  });

  it("has no SQL file the journal skips, other than the known orphans", () => {
    const listed = new Set(tags);
    const unlisted = readdirSync(DRIZZLE)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -4))
      .filter((t) => !listed.has(t));
    expect(unlisted).toEqual(KNOWN_ORPHANS);
  });
});

function adminUrl(): string | null {
  const fromEnv = process.env.MIGRATE_TEST_ADMIN_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, ".env"), "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function connect(): Promise<{ admin: ReturnType<typeof postgres>; url: string } | null> {
  const url = adminUrl();
  if (!url) return null;
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await admin`select 1`;
    return { admin, url };
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}

const conn = await connect();

/** Runs the production runner; `cwd` holds the drizzle/ folder it reads. */
function runMigrate(databaseUrl: string, cwd = ROOT) {
  try {
    const stdout = execFileSync("node", [MIGRATE], {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

// Parallel runs can collide on template1; retry briefly.
async function createDatabase(name: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await conn!.admin.unsafe(`CREATE DATABASE "${name}"`);
    } catch (err) {
      if (attempt >= 5 || !/being accessed by other users/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

describe.skipIf(!conn)("migrate run against a scratch database", () => {
  const dbName = `vardo_migrate_${process.pid}_${Date.now()}`;
  const extras: string[] = [];
  let sql: ReturnType<typeof postgres>;
  let scratchUrl: string;
  let firstRun: { code: number; out: string };

  async function scratch(name: string) {
    await createDatabase(name);
    extras.push(name);
    return withDatabase(conn!.url, name);
  }

  beforeAll(async () => {
    await createDatabase(dbName);
    scratchUrl = withDatabase(conn!.url, dbName);
    firstRun = runMigrate(scratchUrl);
    sql = postgres(scratchUrl, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    for (const name of [dbName, ...extras]) {
      await conn!.admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await conn!.admin.end({ timeout: 1 });
  }, 60_000);

  it("applies every journal entry on an empty database", () => {
    expect(firstRun.code).toBe(0);
    expect(firstRun.out).toContain(`Applied ${tags.length} migration(s)`);
  });

  it("records the journal tags, in order", async () => {
    const rows = await sql`select hash from __drizzle_migrations order by id`;
    expect(rows.map((r) => r.hash)).toEqual(tags);
  });

  it("does nothing on a second run", async () => {
    const again = runMigrate(scratchUrl);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Database is up to date");
    const [{ count }] = await sql`select count(*)::int as count from __drizzle_migrations`;
    expect(count).toBe(tags.length);
  });

  it("builds every table and column the Drizzle schema declares", async () => {
    const rows = await sql`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const actual = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }

    const missing: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const cfg = getTableConfig(value);
      const cols = actual.get(cfg.name);
      if (!cols) {
        missing.push(`table ${cfg.name}`);
        continue;
      }
      for (const c of cfg.columns) if (!cols.has(c.name)) missing.push(`${cfg.name}.${c.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps backup history when its app is deleted, but not the job's app link", async () => {
    const fks = await sql`
      select conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as del
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.conrelid in ('backup'::regclass, 'backup_job_app'::regclass)`;
    const del = (tbl: string, col: string) => fks.find((f) => f.tbl === tbl && f.col === col)?.del;
    expect(del("backup", "app_id")).toBeUndefined();
    expect(del("backup", "job_id")).toBe("n"); // set null
    expect(del("backup_job_app", "app_id")).toBe("c"); // cascade
  });

  it("keeps API tokens made before 0087 at full access", async () => {
    const url = await scratch(`${dbName}_tokens`);
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));
    const before = journal.entries.filter((e) => e.idx < 87);
    try {
      mkdirSync(join(dir, "drizzle/meta"), { recursive: true });
      writeFileSync(join(dir, "drizzle/meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
      for (const e of before) writeFileSync(join(dir, `drizzle/${e.tag}.sql`), readFileSync(join(DRIZZLE, `${e.tag}.sql`)));
      expect(runMigrate(url, dir).code).toBe(0);

      const check = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await check.begin(async (t) => {
          await t`set local session_replication_role = replica`;
          await t`insert into api_token (id, user_id, organization_id, name, token_hash) values ('old', 'u', 'o', 'ci', 'h')`;
        });
        expect(runMigrate(url).code).toBe(0);
        const [row] = await check`select scope, capabilities from api_token where id = 'old'`;
        expect(row).toEqual({ scope: "full", capabilities: null });
      } finally {
        await check.end({ timeout: 1 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("app name uniqueness", () => {
    let tx: ReturnType<typeof postgres>;

    beforeAll(async () => {
      tx = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    });
    afterAll(() => tx.end({ timeout: 1 }));

    async function insertApp(id: string, org: string, name: string, parent: string | null) {
      await tx.begin(async (t) => {
        await t`set local session_replication_role = replica`;
        await t`insert into app (id, organization_id, name, display_name, project_id, parent_app_id)
                values (${id}, ${org}, ${name}, ${name}, 'p', ${parent})`;
      });
    }

    it("rejects the same top-level name in two organizations, under the constraint the code looks for", async () => {
      await insertApp("a1", "org-a", "invoices", null);
      const err = await insertApp("a2", "org-b", "invoices", null).catch((e) => e);
      expect(err).toMatchObject({ code: "23505", constraint_name: TOP_LEVEL_NAME_CONSTRAINT });
    });

    it("lets children of different parents share a name", async () => {
      await insertApp("g1", "org-a", "glitchtip", null);
      await insertApp("g2", "org-b", "glitchtip-other", null);
      await insertApp("c1", "org-a", "glitchtip-web", "g1");
      await expect(insertApp("c2", "org-b", "glitchtip-web", "g2")).resolves.toBeUndefined();
    });
  });

  describe("the runner", () => {
    function fakeProject(files: Record<string, string>) {
      const dir = mkdtempSync(join(tmpdir(), "migrate-"));
      mkdirSync(join(dir, "drizzle/meta"), { recursive: true });
      const entries = Object.keys(files).map((tag, idx) => ({ idx, version: "7", when: idx, tag, breakpoints: true }));
      writeFileSync(join(dir, "drizzle/meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
      for (const [tag, body] of Object.entries(files)) writeFileSync(join(dir, `drizzle/${tag}.sql`), body);
      return dir;
    }

    it("rolls back a failing migration whole, records nothing and stops", async () => {
      const url = await scratch(`${dbName}_fail`);
      const dir = fakeProject({
        "0000_ok": 'CREATE TABLE "t_ok" ("id" int);',
        "0001_bad": 'CREATE TABLE "t_half" ("id" int);--> statement-breakpoint\nSELECT * FROM "no_such_table";',
        "0002_never": 'CREATE TABLE "t_never" ("id" int);',
      });
      try {
        const result = runMigrate(url, dir);
        const check = postgres(url, { max: 1 });
        const tables = (await check`select table_name from information_schema.tables where table_schema = 'public'`).map((r) => r.table_name);
        const recorded = (await check`select hash from __drizzle_migrations order by id`).map((r) => r.hash);
        await check.end({ timeout: 1 });

        expect(result.code).toBe(1);
        expect(tables).toContain("t_ok");
        expect(tables).not.toContain("t_half");
        expect(tables).not.toContain("t_never");
        expect(recorded).toEqual(["0000_ok"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("skips an object that already exists and still records the migration", async () => {
      const url = await scratch(`${dbName}_replay`);
      const dir = fakeProject({
        "0000_make": 'CREATE TABLE "t_dup" ("id" int);',
        "0001_again": 'CREATE TABLE "t_dup" ("id" int);--> statement-breakpoint\nCREATE TABLE "t_next" ("id" int);',
      });
      try {
        const result = runMigrate(url, dir);
        const check = postgres(url, { max: 1 });
        const recorded = (await check`select hash from __drizzle_migrations order by id`).map((r) => r.hash);
        const [{ n }] = await check`select count(*)::int as n from information_schema.tables where table_name = 't_next'`;
        await check.end({ timeout: 1 });

        expect(result.code).toBe(0);
        expect(recorded).toEqual(["0000_make", "0001_again"]);
        expect(n).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
