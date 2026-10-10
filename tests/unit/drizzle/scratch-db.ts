// Scratch Postgres databases for the migration tests, migrated with the production runner (scripts/migrate.mjs).
// Needs a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

export const ROOT = process.cwd();
export const DRIZZLE = join(ROOT, "drizzle");
const MIGRATE = join(ROOT, "scripts/migrate.mjs");

/** Hook and test timeout for anything that replays the migrations. */
export const MIGRATE_TIMEOUT = 120_000;

export type Journal = { version: string; dialect: string; entries: { idx: number; tag: string; when: number }[] };
export const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as Journal;

function adminUrl(): string | null {
  const fromEnv = process.env.MIGRATE_TEST_ADMIN_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, ".env"), "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export type ScratchServer = {
  admin: ReturnType<typeof postgres>;
  url: string;
  create(name: string): Promise<string>;
  dropAll(): Promise<void>;
};

/** A connection to the `postgres` database, or null when none is reachable. */
export async function connectScratchServer(): Promise<ScratchServer | null> {
  const url = adminUrl();
  if (!url) return null;
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await admin`select 1`;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    return null;
  }

  const created: string[] = [];
  return {
    admin,
    url,
    // Concurrent creates collide on template1.
    async create(name) {
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.unsafe(`CREATE DATABASE "${name}"`);
          created.push(name);
          return withDatabase(url, name);
        } catch (err) {
          if (attempt >= 10 || !/being accessed by other users/.test(String(err))) throw err;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    },
    async dropAll() {
      for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    },
  };
}

/** A unique scratch database name for this worker. */
export function scratchName(label: string): string {
  return `vardo_migrate_${label}_${process.pid}_${Date.now()}`;
}

/** Runs the production runner without blocking the worker; `cwd` holds the drizzle/ folder it reads. */
export function runMigrate(databaseUrl: string, cwd = ROOT): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [MIGRATE],
      { cwd, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

/** A temp project whose journal holds only the entries `keep` passes. */
export function projectWith(keep: (entry: Journal["entries"][number]) => boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  mkdirSync(join(dir, "drizzle/meta"), { recursive: true });
  const entries = journal.entries.filter(keep);
  writeFileSync(join(dir, "drizzle/meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) copyFileSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `drizzle/${e.tag}.sql`));
  return dir;
}

/** A temp project whose journal stops before `tag`. */
export function projectBefore(tag: string): string {
  const stop = journal.entries.findIndex((e) => e.tag === tag);
  return projectWith((e) => e.idx < stop);
}
