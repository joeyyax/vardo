import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { gzipSync, gunzipSync } from "zlib";
import { detectFormat, ImportError, stageImport, writesMysqlSystemSchema } from "@/lib/backups/import";
import { buildPgRestoreArgv, buildRestoreArgv, defaultDatabase } from "@/lib/backups/dump-spec";

function tarHeader(): Buffer {
  const b = Buffer.alloc(512);
  b.write("file.txt", 0);
  b.write("ustar", 257);
  return b;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vardo-import-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detectFormat", () => {
  it("reads the pg_dump custom magic", () => {
    expect(detectFormat(Buffer.from("PGDMP\x01\x0e\x00"))).toBe("pg-custom");
  });

  it("reads a tar header", () => {
    expect(detectFormat(tarHeader())).toBe("tar");
  });

  it("treats anything else as SQL", () => {
    expect(detectFormat(Buffer.from("-- MariaDB dump\nCREATE TABLE t (id int);"))).toBe("sql");
  });
});

describe("stageImport", () => {
  it("gzips a plain file and keeps its format", async () => {
    const sql = Buffer.from("CREATE TABLE t (id int);\n");
    const staged = await stageImport(Readable.from([sql]), dir);
    expect(staged.format).toBe("sql");
    expect(staged.bytes).toBe(sql.length);
    expect(gunzipSync(readFileSync(staged.path)).equals(sql)).toBe(true);
  });

  it("sniffs a gzipped file by its contents", async () => {
    const staged = await stageImport(Readable.from([gzipSync(tarHeader())]), dir);
    expect(staged.format).toBe("tar");
  });

  it("refuses a file over the limit while it streams", async () => {
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(stageImport(big, dir, 1000)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a truncated gzip before anything stops", async () => {
    const gz = gzipSync(Buffer.alloc(100_000, "x"));
    await expect(stageImport(Readable.from([gz.subarray(0, gz.length - 20)]), dir)).rejects.toBeInstanceOf(ImportError);
  });

  it("refuses an empty file", async () => {
    await expect(stageImport(Readable.from([]), dir)).rejects.toThrow("empty");
  });

  it("leaves only the payload behind", async () => {
    const staged = await stageImport(Readable.from([Buffer.from("SELECT 1;")]), dir);
    expect(statSync(staged.path).isFile()).toBe(true);
    expect(() => statSync(join(dir, "source"))).toThrow();
  });
});

describe("writesMysqlSystemSchema", () => {
  async function staged(sql: string) {
    return (await stageImport(Readable.from([Buffer.from(sql)]), dir)).path;
  }

  it("flags an --all-databases dump", async () => {
    expect(await writesMysqlSystemSchema(await staged("USE `wp`;\nINSERT 1;\nUSE `mysql`;\nINSERT 2;\n"))).toBe(true);
  });

  it("passes a single-database dump", async () => {
    expect(await writesMysqlSystemSchema(await staged("CREATE DATABASE `wp`;\nUSE `wp`;\nINSERT INTO t VALUES ('USE `mysql`;');\n"))).toBe(false);
  });
});

describe("restore argv for imports", () => {
  const env = ["POSTGRES_USER=app", "POSTGRES_DB=appdb", "MARIADB_DATABASE=wp"];

  it("loads a custom archive in one transaction, keeping its owners and grants", () => {
    const argv = buildPgRestoreArgv("c", env);
    expect(argv).toEqual(expect.arrayContaining(["pg_restore", "-U", "app", "-d", "appdb", "--single-transaction", "--exit-on-error"]));
    expect(argv).not.toContain("--no-owner");
    expect(argv).not.toContain("--no-privileges");
  });

  it("passes a MySQL database as an argument, never inside the script", () => {
    const argv = buildRestoreArgv("mariadb", "c", env, "wp");
    expect(argv.at(-2)).toBe("sh");
    expect(argv.at(-1)).toBe("wp");
    expect(argv.at(-3)).toContain('"$1"');
    expect(argv.at(-3)).not.toContain("wp");
  });

  it("leaves the backup restore argv as it was without a database", () => {
    expect(buildRestoreArgv("mysql", "c", [])).toEqual(["exec", "-i", "c", "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root']);
  });

  it("defaults to the database the image created", () => {
    expect(defaultDatabase("mariadb", env)).toBe("wp");
    expect(defaultDatabase("postgres", env)).toBe("appdb");
    expect(defaultDatabase("mysql", [])).toBeNull();
  });
});
