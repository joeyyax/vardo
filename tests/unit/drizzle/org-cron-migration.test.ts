// 0098 on a scratch database: existing jobs get their app's org, org-level URL jobs need no app,
// command jobs still do and deleting an app removes only its own jobs.
// Same connection rules as migrate-run.test.ts; skips without a Postgres it can create databases on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const ROOT = process.cwd();
const DRIZZLE = join(ROOT, "drizzle");
const MIGRATE = join(ROOT, "scripts/migrate.mjs");
const TAG = "0098_org_cron";
const SQL_TEXT = readFileSync(join(DRIZZLE, `${TAG}.sql`), "utf8");

type Journal = { version: string; dialect: string; entries: { idx: number; tag: string }[] };
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as Journal;

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

async function connect() {
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

function runMigrate(databaseUrl: string, cwd: string) {
  return execFileSync("node", [MIGRATE], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A project whose journal stops before `tag`. */
function projectBefore(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-0098-"));
  mkdirSync(join(dir, "drizzle/meta"), { recursive: true });
  const stop = journal.entries.findIndex((e) => e.tag === tag);
  const entries = journal.entries.slice(0, stop);
  writeFileSync(join(dir, "drizzle/meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) copyFileSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `drizzle/${e.tag}.sql`));
  return dir;
}

describe.skipIf(!conn)("0098 org cron migration, on a scratch database", () => {
  const dbName = `vardo_migrate_0098_${process.pid}_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let before: string;

  beforeAll(async () => {
    await conn!.admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = withDatabase(conn!.url, dbName);
    before = projectBefore(TAG);
    runMigrate(url, before);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into organization (id, name, slug) values ('o1', 'Example', 'example')`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a1', 'o1', 'web', 'Web', 'p1')`;
      await t`insert into app (id, organization_id, name, display_name, project_id) values ('a2', 'o1', 'api', 'API', 'p1')`;
      await t`insert into cron_job (id, app_id, name, schedule, command) values ('c1', 'a1', 'cleanup', '0 * * * *', 'id')`;
      await t`insert into cron_job (id, app_id, name, type, schedule, command) values ('c2', 'a2', 'ping', 'url', '* * * * *', 'https://example.com')`;
    });
    runMigrate(url, ROOT);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (before) rmSync(before, { recursive: true, force: true });
    await conn!.admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await conn!.admin.end({ timeout: 1 });
  });

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
