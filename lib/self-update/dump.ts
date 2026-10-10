// Dumps Vardo's own database before an update, into the lifecycle dir the console owns.

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { dockerEnv } from "@/lib/docker/docker-env";
import { LIFECYCLE_DIR } from "@/lib/paths";

export const DUMP_DIR = join(LIFECYCLE_DIR, "backups");
const KEEP = 3;
const POSTGRES_CONTAINER = "vardo-postgres";
const SAFE_NAME = /^[A-Za-z0-9_-]{1,63}$/;

/** User and database from DATABASE_URL, defaulting to the install's `host`/`host`. */
export function dumpTarget(databaseUrl: string | undefined): { user: string; database: string } {
  try {
    const url = new URL(databaseUrl ?? "");
    const user = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (SAFE_NAME.test(user) && SAFE_NAME.test(database)) return { user, database };
  } catch {
    // Default below.
  }
  return { user: "host", database: "host" };
}

export function dumpFileName(now: Date): string {
  return `pre-update-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sql.gz`;
}

/** Newest dumps to keep, then the rest to remove. */
export function dumpsToPrune(names: string[], keep = KEEP): string[] {
  return names
    .filter((n) => /^pre-update-.*\.sql\.gz$/.test(n))
    .sort()
    .reverse()
    .slice(keep);
}

/** Writes a gzipped pg_dump and returns its path. Throws when the dump fails or comes out empty. */
export async function dumpVardoDatabase(now = new Date()): Promise<string> {
  await mkdir(DUMP_DIR, { recursive: true, mode: 0o700 });
  const file = join(DUMP_DIR, dumpFileName(now));
  const { user, database } = dumpTarget(process.env.DATABASE_URL);

  const child = spawn("docker", ["exec", POSTGRES_CONTAINER, "pg_dump", "-U", user, database], {
    env: dockerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });

  try {
    await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(file, { mode: 0o600 })), exited]);
    if ((await stat(file)).size < 100) throw new Error("pg_dump wrote an empty file");
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }

  const old = dumpsToPrune(await readdir(DUMP_DIR).catch(() => []));
  await Promise.all(old.map((n) => rm(join(DUMP_DIR, n), { force: true })));
  return file;
}
