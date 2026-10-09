import { describe, it, expect } from "vitest";
import {
  readEnv,
  buildDumpArgv,
  buildRestoreArgv,
  describeDumpSpec,
} from "@/lib/backups/dump-spec";

const PG_ENV = ["POSTGRES_USER=appuser", "POSTGRES_DB=appdb", "POSTGRES_PASSWORD=hunter2"];

describe("readEnv", () => {
  it("reads a value", () => {
    expect(readEnv(PG_ENV, "POSTGRES_USER")).toBe("appuser");
  });

  it("returns null for a key that is absent", () => {
    expect(readEnv(PG_ENV, "NOPE")).toBeNull();
  });

  it("keeps everything after the first = — passwords contain them", () => {
    expect(readEnv(["P=a=b=c"], "P")).toBe("a=b=c");
  });

  it("does not match on a prefix of the key", () => {
    expect(readEnv(["POSTGRES_USERNAME=x"], "POSTGRES_USER")).toBeNull();
  });

  it("handles an empty value", () => {
    expect(readEnv(["EMPTY="], "EMPTY")).toBe("");
  });
});

describe("buildDumpArgv — postgres", () => {
  it("dumps the configured user and database", () => {
    expect(buildDumpArgv("postgres", "abc123", PG_ENV)).toEqual([
      "exec", "abc123", "pg_dump", "-U", "appuser", "--clean", "--if-exists", "appdb",
    ]);
  });

  it("includes --clean --if-exists, without which the dump only restores into an empty database", () => {
    const argv = buildDumpArgv("postgres", "c", PG_ENV);
    expect(argv).toContain("--clean");
    expect(argv).toContain("--if-exists");
  });

  it("falls back to the image defaults", () => {
    expect(buildDumpArgv("postgres", "c", [])).toEqual([
      "exec", "c", "pg_dump", "-U", "postgres", "--clean", "--if-exists", "postgres",
    ]);
  });

  it("defaults the database to the user, which is what the image does", () => {
    expect(buildDumpArgv("postgres", "c", ["POSTGRES_USER=solo"])).toContain("solo");
  });

  it("passes no password — the official image trusts the local socket", () => {
    expect(buildDumpArgv("postgres", "c", PG_ENV).join(" ")).not.toContain("hunter2");
  });
});

describe("buildRestoreArgv — postgres", () => {
  it("stops on the first error rather than exiting 0 after skipping statements", () => {
    expect(buildRestoreArgv("postgres", "abc123", PG_ENV)).toEqual([
      "exec", "-i", "abc123",
      "psql", "-U", "appuser", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", "appdb",
    ]);
  });

  it("restores in one transaction, so a failure leaves the database as it was", () => {
    expect(buildRestoreArgv("postgres", "c", PG_ENV)).toContain("--single-transaction");
  });

  it("keeps stdin open, since the dump arrives that way", () => {
    expect(buildRestoreArgv("postgres", "c", PG_ENV)).toContain("-i");
  });
});

describe("buildDumpArgv — mysql and mariadb", () => {
  it("reads the password inside the container, never on the host argv", () => {
    const argv = buildDumpArgv("mysql", "c", ["MYSQL_ROOT_PASSWORD=hunter2"]);
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(argv.join(" ")).toContain("$MYSQL_ROOT_PASSWORD");
  });

  it("dumps consistently", () => {
    expect(buildDumpArgv("mysql", "c", []).join(" ")).toContain("--single-transaction");
  });

  it("keeps routines and events", () => {
    for (const kind of ["mysql", "mariadb"] as const) {
      expect(buildDumpArgv(kind, "c", []).join(" ")).toContain("--routines --events");
    }
  });

  it("uses the mariadb-* clients when the image has them, as MariaDB 11 images ship no mysql*", () => {
    const dump = buildDumpArgv("mariadb", "c", []).join(" ");
    expect(dump).toContain("command -v mariadb-dump || command -v mysqldump");
    const restore = buildRestoreArgv("mariadb", "c", []).join(" ");
    expect(restore).toContain("command -v mariadb || command -v mysql");
  });

  it("reads MARIADB_ROOT_PASSWORD first and falls back to MYSQL_ROOT_PASSWORD", () => {
    const argv = buildDumpArgv("mariadb", "c", ["MARIADB_ROOT_PASSWORD=hunter2"]);
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(argv.join(" ")).toContain("${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}");
  });
});

describe("buildDumpArgv — uptime-kuma", () => {
  it("copies the live database the way the instance stores it", () => {
    const script = buildDumpArgv("uptime-kuma", "c", []).at(-1)!;
    expect(script).toContain("mariadb-dump --socket=/app/data/run/mariadb.sock");
    expect(script).toContain("--single-transaction");
    expect(script).toContain(".backup");
  });

  it("leaves the live database files out of the archive", () => {
    const script = buildDumpArgv("uptime-kuma", "c", []).at(-1)!;
    for (const path of ["./mariadb", "./run", "./kuma.db", "./kuma.db-wal", "./kuma.db-shm"]) {
      expect(script).toContain(`--exclude=${path} `);
    }
  });

  it("refuses an external database rather than archiving config alone", () => {
    expect(buildDumpArgv("uptime-kuma", "c", []).at(-1)).toContain("back that database up instead");
  });

  it("restores the database before the files, from a temp dir on the same volume", () => {
    const script = buildRestoreArgv("uptime-kuma", "c", []).at(-1)!;
    expect(script).toContain("mktemp -d /app/data/.vardo-restore.");
    expect(script.indexOf(".restore")).toBeLessThan(script.indexOf("cp -a"));
  });
});

describe("buildDumpArgv — mongo", () => {
  it("keeps credentials in the container", () => {
    const argv = buildDumpArgv("mongo", "c", ["MONGO_INITDB_ROOT_PASSWORD=hunter2"]);
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(argv.join(" ")).toContain("--archive");
  });

  it("drops before restoring, so the result is the dump and not a merge", () => {
    expect(buildRestoreArgv("mongo", "c", []).join(" ")).toContain("--drop");
  });
});

describe("argv shape", () => {
  it("never contains a container name, only the id it was resolved to", () => {
    // The whole point: nothing here survives from configuration except the id
    // passed in, which was resolved moments ago.
    for (const kind of ["postgres", "mysql", "mariadb", "mongo", "uptime-kuma"] as const) {
      expect(buildDumpArgv(kind, "resolved-id", [])[1]).toBe("resolved-id");
    }
  });
});

describe("describeDumpSpec", () => {
  it("names the tool and the service", () => {
    expect(describeDumpSpec({ kind: "postgres", service: "app-db" })).toBe(
      'pg_dump against the "app-db" service',
    );
    expect(describeDumpSpec({ kind: "mariadb", service: "db" })).toContain("mariadb-dump");
  });
});
