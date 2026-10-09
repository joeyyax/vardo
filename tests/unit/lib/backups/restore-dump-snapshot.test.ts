// A mysql or mongo restore cannot run in one transaction, so a failure part-way
// leaves a half-replaced database. The engine dumps the live database first and
// replays that dump when the restore fails. Postgres restores into scratch
// databases and swaps them in instead, so it needs no copy.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { copyFile } from "fs/promises";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = mkdtempSync(join(tmpdir(), "vardo-restore-dump-"));
const SOURCE = join(ROOT, "source.dump.gz");
const BYTES = gzipSync(Buffer.from("-- backup dump\n".repeat(20)));
const CHECKSUM = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;

const { backupsFindFirst, volumesFindFirst, spawnMock, resolveDbContainerMock, restorePostgresMock } = vi.hoisted(() => ({
  backupsFindFirst: vi.fn(),
  volumesFindFirst: vi.fn(),
  spawnMock: vi.fn(),
  resolveDbContainerMock: vi.fn(),
  restorePostgresMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { backups: { findFirst: backupsFindFirst }, volumes: { findFirst: volumesFindFirst } } },
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: spawnMock,
}));
vi.mock("@/lib/docker/client", () => ({
  listContainers: vi.fn().mockResolvedValue([]),
  inspectContainer: vi.fn(),
  dockerRequest: vi.fn().mockResolvedValue([]),
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
}));
vi.mock("@/lib/docker/resolve-env", () => ({
  resolveDefaultEnv: vi.fn().mockResolvedValue({ name: "production" }),
}));
vi.mock("@/lib/backups/resolve-db-container", () => ({ resolveDbContainer: resolveDbContainerMock }));
vi.mock("@/lib/backups/pg-cluster", () => ({
  createPgClusterProducer: vi.fn(),
  restorePostgresArchive: restorePostgresMock,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({
    download: vi.fn(async (_key: string, dest: string) => {
      await copyFile(SOURCE, dest);
    }),
  }),
}));

import { restoreBackup } from "@/lib/backups/engine";

type Call = { kind: "dump" | "restore"; argv: string[]; stdin: string };
let calls: Call[];
let failRestores: number;
let epipeRestores: number;

/** A fake `docker exec`: a dump writes to stdout, a restore reads stdin. */
function fakeDocker(_cmd: string, argv: string[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const isRestore = argv.includes("-i");
  const call: Call = { kind: isRestore ? "restore" : "dump", argv, stdin: "" };
  calls.push(call);

  child.stdin = new Writable({
    write(chunk, _enc, done) {
      call.stdin += String(chunk);
      done();
    },
  });

  if (isRestore && epipeRestores > 0) {
    epipeRestores--;
    // Dies on its first statement: stdin breaks before the exit lands.
    child.stdin = new Writable({
      write(_chunk, _enc, done) {
        child.stderr.write("ERROR:  cannot drop inherited constraint\n");
        done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        setTimeout(() => child.emit("close", 1), 20);
      },
    });
  } else if (isRestore) {
    child.stdin.on("finish", () => {
      const fail = failRestores > 0;
      if (fail) failRestores--;
      setImmediate(() => child.emit("close", fail ? 1 : 0));
    });
  } else {
    setImmediate(() => {
      child.stdout.end("-- live database\n");
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
  }
  return child;
}

function row(kind: string) {
  backupsFindFirst.mockResolvedValue({
    id: "bk-1",
    appId: "app-1",
    volumeName: "db",
    storagePath: "org/app/db/backup.dump.gz",
    strategy: "dump",
    checksum: CHECKSUM,
    sizeBytes: BYTES.length,
    target: { organizationId: "org-1" },
    app: { name: "myapp" },
  });
  volumesFindFirst.mockResolvedValue({ backupSpec: { kind, service: "db" } });
}

beforeAll(() => writeFileSync(SOURCE, BYTES));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  calls = [];
  failRestores = 0;
  epipeRestores = 0;
  spawnMock.mockReset().mockImplementation(fakeDocker);
  resolveDbContainerMock.mockResolvedValue({ id: "c-db", env: [] });
});

describe("dump restore snapshot", () => {
  it("dumps a mysql database before restoring over it", async () => {
    row("mysql");

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["dump", "restore"]);
    expect(calls[1].stdin).toContain("-- backup dump");
  });

  it("replays the pre-restore dump when the mysql restore fails", async () => {
    row("mysql");
    failRestores = 1;

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(["dump", "restore", "restore"]);
    expect(calls[2].stdin).toBe("-- live database\n");
    expect(result.log).toMatch(/Previous database restored/);
  });

  it("reports the restore's stderr, not the EPIPE its exit causes", async () => {
    row("mysql");
    epipeRestores = 1;

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(result.log).toMatch(/restore exited 1: ERROR: {2}cannot drop inherited constraint/);
    expect(result.log).not.toContain("EPIPE");
  });

  it("keeps the pre-restore dump when the replay fails too", async () => {
    row("mongo");
    failRestores = 2;

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    const kept = result.log.match(/Pre-restore copy kept at (\S+)/)?.[1];
    expect(kept).toBeDefined();
    expect(readFileSync(kept!).length).toBeGreaterThan(0);
    rmSync(kept!);
  });

  it("restores postgres through scratch databases, with no separate dump", async () => {
    row("postgres");
    restorePostgresMock.mockResolvedValue({ format: "cluster", databases: ["app"] });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(calls).toEqual([]);
    expect(restorePostgresMock).toHaveBeenCalledWith(expect.objectContaining({ containerId: "c-db" }));
  });
});
