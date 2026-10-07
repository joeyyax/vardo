// Restore drills: restore into something disposable and check the contents load. Container work is in drill.ts.

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
  /** Prints a single number: how much structure the restore created. */
  countArgv: string[];
};

/** Scratch instance with the live container's user and database, so ownership and \connect lines resolve. */
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
      // Throwaway password, so the real one never reaches a command line.
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

/** Whether a restored copy counts as verified. Exiting 0 having created nothing fails. */
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
