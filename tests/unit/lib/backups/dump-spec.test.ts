import { describe, it, expect } from "vitest";
import {
  readEnv,
  buildDumpArgv,
  buildRestoreArgv,
  describeDumpSpec,
} from "@/lib/backups/dump-spec";

const PG_ENV = ["POSTGRES_USER=paperless", "POSTGRES_DB=paperless", "POSTGRES_PASSWORD=hunter2"];

describe("readEnv", () => {
  it("reads a value", () => {
    expect(readEnv(PG_ENV, "POSTGRES_USER")).toBe("paperless");
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
      "exec", "abc123", "pg_dump", "-U", "paperless", "--clean", "--if-exists", "paperless",
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
    expect(buildDumpArgv("postgres", "c", ["POSTGRES_USER=outline"])).toContain("outline");
  });

  it("passes no password — the official image trusts the local socket", () => {
    expect(buildDumpArgv("postgres", "c", PG_ENV).join(" ")).not.toContain("hunter2");
  });
});

describe("buildRestoreArgv — postgres", () => {
  it("stops on the first error rather than exiting 0 after skipping statements", () => {
    expect(buildRestoreArgv("postgres", "abc123", PG_ENV)).toEqual([
      "exec", "-i", "abc123", "psql", "-U", "paperless", "-v", "ON_ERROR_STOP=1", "-d", "paperless",
    ]);
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

  it("treats mariadb the same as mysql", () => {
    expect(buildDumpArgv("mariadb", "c", [])).toEqual(buildDumpArgv("mysql", "c", []));
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
    for (const kind of ["postgres", "mysql", "mariadb", "mongo"] as const) {
      expect(buildDumpArgv(kind, "resolved-id", [])[1]).toBe("resolved-id");
    }
  });
});

describe("describeDumpSpec", () => {
  it("names the tool and the service", () => {
    expect(describeDumpSpec({ kind: "postgres", service: "paperless-db" })).toBe(
      'pg_dump against the "paperless-db" service',
    );
    expect(describeDumpSpec({ kind: "mariadb", service: "db" })).toContain("mysqldump");
  });
});
