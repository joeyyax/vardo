// ---------------------------------------------------------------------------
// Restore drills
//
// The engine already proves an archive is well-formed — gzip integrity, a size
// floor, a checksum re-checked on download. That proves the bytes survived the
// round trip. It says nothing about whether the contents load: a pg_dump taken
// against the wrong database, a torn SQLite file, and a dump truncated by an
// OOM kill all produce a valid gzip with a matching checksum.
//
// A drill restores into somewhere disposable and asks the restored copy a
// question only a real load can answer.
//
// Pure — the container work lives in drill.ts, the decisions live here.
// ---------------------------------------------------------------------------

import type { DatabaseKind } from "./durability";

export type DrillOutcome = "verified" | "failed" | "unsupported";

/** What a scratch database needs to accept a dump taken from the original. */
export type ScratchDatabase = {
  image: string;
  env: string[];
  /** Command that exits 0 once the database is ready for connections. */
  readyArgv: string[];
  /** Reads the dump on stdin. */
  restoreArgv: string[];
  /** Prints a single number: how much structure the restore actually created. */
  countArgv: string[];
};

/**
 * A dump restored into a fresh instance of a *different* user or database name
 * fails on ownership and \connect lines, so the scratch instance is built from
 * the same values the dump was taken with. They come from the live container's
 * environment rather than anywhere they might have gone stale.
 */
export function scratchDatabaseFor(
  kind: DatabaseKind,
  image: string,
  sourceEnv: string[],
): ScratchDatabase | null {
  const read = (key: string): string | null => {
    const prefix = `${key}=`;
    for (const line of sourceEnv) if (line.startsWith(prefix)) return line.slice(prefix.length);
    return null;
  };

  if (kind === "postgres") {
    const user = read("POSTGRES_USER") || "postgres";
    const database = read("POSTGRES_DB") || user;
    return {
      image,
      // A throwaway password: the scratch container is never published, and
      // reusing the real one would put it on a command line.
      env: [`POSTGRES_USER=${user}`, `POSTGRES_DB=${database}`, "POSTGRES_PASSWORD=drill"],
      readyArgv: ["pg_isready", "-U", user, "-d", database],
      restoreArgv: ["psql", "-U", user, "-v", "ON_ERROR_STOP=1", "-d", database],
      countArgv: [
        "psql", "-U", user, "-d", database, "-tAc",
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
      ],
    };
  }

  if (kind === "mysql" || kind === "mariadb") {
    const password = read("MYSQL_ROOT_PASSWORD") || "drill";
    return {
      image,
      env: [`MYSQL_ROOT_PASSWORD=${password}`],
      readyArgv: ["sh", "-c", 'mysqladmin ping -u root -p"$MYSQL_ROOT_PASSWORD" --silent'],
      restoreArgv: ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root'],
      countArgv: [
        "sh", "-c",
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root -N -B -e "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN (\'mysql\',\'information_schema\',\'performance_schema\',\'sys\')"',
      ],
    };
  }

  return null;
}

/**
 * Whether a restored copy counts as verified.
 *
 * A restore that exits 0 having created nothing is the failure this exists to
 * catch — an empty dump applies cleanly and tells you nothing.
 */
export function judgeDrill(input: {
  restoreExitCode: number;
  objectCount: number | null;
}): { outcome: DrillOutcome; detail: string } {
  if (input.restoreExitCode !== 0) {
    return { outcome: "failed", detail: `restore exited ${input.restoreExitCode}` };
  }
  if (input.objectCount === null) {
    return { outcome: "failed", detail: "restored copy could not be inspected" };
  }
  if (input.objectCount <= 0) {
    return { outcome: "failed", detail: "restore applied cleanly but created no tables" };
  }
  return { outcome: "verified", detail: `${input.objectCount} table(s) restored` };
}

/** Judge a file archive by what came back out of it. */
export function judgeArchiveDrill(input: {
  extractExitCode: number;
  fileCount: number | null;
}): { outcome: DrillOutcome; detail: string } {
  if (input.extractExitCode !== 0) {
    return { outcome: "failed", detail: `extract exited ${input.extractExitCode}` };
  }
  if (input.fileCount === null) {
    return { outcome: "failed", detail: "extracted copy could not be inspected" };
  }
  if (input.fileCount <= 0) {
    return { outcome: "failed", detail: "archive extracted but held no files" };
  }
  return { outcome: "verified", detail: `${input.fileCount} file(s) extracted` };
}

/** Name for a drill's scratch container. Unique per run so drills never collide. */
export function scratchContainerName(token: string): string {
  return `vardo-drill-${token}`;
}
