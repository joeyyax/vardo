// runBackup coverage for two silent-data-loss bugs:
//  1. Bind mounts were tarred like named volumes, so every run left a "failed"
//     row and the operator could not tell an unsupported source from a broken
//     one. They are now recorded as "skipped" and never count as a success.
//  2. Running a job to back up one app also backed up every sibling app on that
//     job. The unscoped test below is the reproduction; the scoped one is the fix.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-runbackup-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;

const {
  backupJobsFindFirst,
  volumesFindMany,
  backupsFindMany,
  backupsFindFirst,
  execFileMock,
  spawnMock,
  emitMock,
  uploadMock,
  listContainersMock,
  resolveDefaultEnvMock,
  inserted,
  updated,
} = vi.hoisted(() => ({
  backupJobsFindFirst: vi.fn(),
  volumesFindMany: vi.fn(),
  backupsFindMany: vi.fn(),
  backupsFindFirst: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  emitMock: vi.fn(),
  uploadMock: vi.fn(),
  listContainersMock: vi.fn(),
  resolveDefaultEnvMock: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  updated: [] as { table: unknown; set: Record<string, unknown> }[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobs: { findFirst: backupJobsFindFirst },
      volumes: { findMany: volumesFindMany },
      backups: { findMany: backupsFindMany, findFirst: backupsFindFirst },
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push(values);
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updated.push({ table, set });
        },
      }),
    }),
  },
}));
vi.mock("child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: emitMock }));
vi.mock("@/lib/docker/client", () => ({
  listContainers: listContainersMock,
  inspectContainer: vi.fn(),
}));
vi.mock("@/lib/docker/resolve-env", () => ({ resolveDefaultEnv: resolveDefaultEnvMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({ uploadStream: uploadMock, delete: vi.fn(), download: vi.fn() }),
}));

import { runBackup, runSucceeded } from "@/lib/backups/engine";
import {
  DIRECTORY_SOURCE_MARKER,
  EMPTY_SOURCE_MARKER,
  MARKERS_FILE,
  MIN_VALID_GZIP_BYTES,
} from "@/lib/backups/archive";
import { backupJobs } from "@/lib/db/schema";
import { VALID_ARCHIVE, fakeChild, recordingUpload, tarGz } from "./fake-archive";

const execImpl = (...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
  cb(null, { stdout: "", stderr: "" });
};

// Random, so its gzip clears the size floor.
const DUMP_BYTES = Buffer.from(randomBytes(512).toString("hex"));

// Stands in for the archiving container and dump commands: their stdout is the archive.
const spawnImpl = (file: string, argv: string[]) => {
  if (file === "docker" && argv[0] === "run") return fakeChild({ stdout: VALID_ARCHIVE });
  return fakeChild({ stdout: DUMP_BYTES });
};

/** What reached storage with a clean end. */
const committed: { key: string; bytes: Buffer }[] = [];

/** The work dir mounted at /backup in a spawned docker run. */
function workDirOf(argv: string[]): string {
  const mount = argv.find((a) => a.endsWith(":/backup"))!;
  return mount.slice(0, -":/backup".length);
}

function volume(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-1",
    name: "data",
    mountPath: "/data",
    type: "named",
    source: null,
    persistent: true,
    backupStrategy: "tar",
    backupMeta: null,
    ...overrides,
  };
}

function jobApp(id: string, organizationId = "org-1", status = "active") {
  return { app: { id, name: id, organizationId, status, organization: { slug: "acme" } } };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "Nightly",
    organizationId: "org-1",
    notifyOnFailure: true,
    notifyOnSuccess: false,
    keepAll: false,
    keepLast: null,
    keepHourly: null,
    keepDaily: null,
    keepWeekly: null,
    keepMonthly: null,
    keepYearly: null,
    target: { id: "tgt-1", type: "s3", config: {}, organizationId: "org-1" },
    backupJobApps: [jobApp("app-a")],
    backupJobVolumes: [],
    ...overrides,
  };
}

/** Volume rows returned per app, in job order. */
function volumesPerApp(...groups: Record<string, unknown>[][]) {
  let call = 0;
  volumesFindMany.mockImplementation(async () => groups[call++] ?? []);
}

/** Events of one type emitted during the run, in order. */
function emitted(type: string): Record<string, unknown>[] {
  return emitMock.mock.calls
    .map((c) => c[1] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

/** Org each event of a type went to, in order. */
function emittedOrgs(type: string): string[] {
  return emitMock.mock.calls
    .filter((c) => (c[1] as Record<string, unknown>).type === type)
    .map((c) => c[0] as string);
}

function dockerRuns(): string[][] {
  return [...execFileMock.mock.calls, ...spawnMock.mock.calls]
    .filter((c) => c[0] === "docker" && (c[1] as string[])[0] === "run")
    .map((c) => c[1] as string[]);
}

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

beforeAll(() => {
  uploadMock.mockImplementation(recordingUpload(committed));
});

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
  committed.length = 0;
  execFileMock.mockReset().mockImplementation(execImpl);
  spawnMock.mockReset().mockImplementation(spawnImpl);
  emitMock.mockReset();
  volumesFindMany.mockReset();
  backupsFindMany.mockReset().mockResolvedValue([]);
  backupsFindFirst.mockReset().mockResolvedValue(undefined);
  listContainersMock.mockReset().mockResolvedValue([]);
  resolveDefaultEnvMock.mockReset().mockResolvedValue({ id: "env-1", name: "production" });
  uploadMock.mockClear();
});

describe("runBackup — bind mounts", () => {
  it("records a bind mount as skipped, not failed, and never runs tar", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ type: "bind", source: "/srv/app-a/data" })]);

    const results = await runBackup("job-1");

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("skipped");
    expect(results[0].error).toMatch(/\/srv\/app-a\/data/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("skipped");
    expect(inserted[0].finishedAt).toBeInstanceOf(Date);
    expect(dockerRuns()).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });

  it("does not report a run where every source was skipped as successful", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ notifyOnSuccess: true }));
    volumesPerApp([volume({ type: "bind", source: "/srv/app-a/data" })]);

    const results = await runBackup("job-1");

    expect(results.some((r) => r.outcome === "success")).toBe(false);
    const outcomes = emitted("backup.failed");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].message).toMatch(/Nothing was captured/);
  });

  it("still captures the named volumes sitting beside a bind mount", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([
      volume({ id: "vol-1", name: "data" }),
      volume({ id: "vol-2", name: "uploads", type: "bind", source: "/srv/uploads" }),
    ]);

    const results = await runBackup("job-1");

    expect(results.map((r) => [r.volumeName, r.outcome])).toEqual([
      ["data", "success"],
      ["uploads", "skipped"],
    ]);
    expect(dockerRuns()).toHaveLength(1);
  });

  it("backs up a bind mount that has a dump command", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([
      volume({
        type: "bind",
        source: "/srv/pgdata",
        backupStrategy: "dump",
        backupMeta: { dumpCmd: "docker exec pg pg_dump -U u db", restoreCmd: "" },
      }),
    ]);

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("success");
    expect(spawnMock.mock.calls.some((c) => c[0] === "bash")).toBe(true);
  });
});

describe("runBackup — app scoping", () => {
  it("backs up every app on the job when no scope is given", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [jobApp("app-a"), jobApp("app-b")] }),
    );
    volumesPerApp([volume({ name: "a-data" })], [volume({ id: "vol-2", name: "b-data" })]);

    const results = await runBackup("job-1");

    expect(results.map((r) => r.volumeName)).toEqual(["a-data", "b-data"]);
  });

  it("backs up only the requested app when the job covers siblings", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [jobApp("app-a"), jobApp("app-b")] }),
    );
    volumesPerApp([volume({ name: "a-data" })], [volume({ id: "vol-2", name: "b-data" })]);

    const results = await runBackup("job-1", { appIds: ["app-a"] });

    expect(results.map((r) => r.volumeName)).toEqual(["a-data"]);
    expect(volumesFindMany).toHaveBeenCalledTimes(1);
    expect(inserted.map((row) => row.appId)).toEqual(["app-a"]);
  });

  it("leaves lastRunAt alone when the run covered part of the job", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [jobApp("app-a"), jobApp("app-b")] }),
    );
    volumesPerApp([volume({ name: "a-data" })], [volume({ id: "vol-2", name: "b-data" })]);

    await runBackup("job-1", { appIds: ["app-a"] });

    expect(updated.some((u) => u.table === backupJobs)).toBe(false);
  });

  it("refreshes lastRunAt when the run covered the whole job", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "a-data" })]);

    await runBackup("job-1", { appIds: ["app-a"] });

    expect(updated.some((u) => u.table === backupJobs && u.set.lastRunAt instanceof Date)).toBe(true);
  });

  // lastRunAt feeds backup-stale. A run that archived nothing must not silence it.
  it("leaves lastRunAt alone when the run captured nothing", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "a-data" })]);
    spawnMock.mockImplementation(() => fakeChild({ code: 1, stderr: "docker run failed" }));

    const results = await runBackup("job-1");

    expect(results.some((r) => r.outcome === "success")).toBe(false);
    expect(updated.some((u) => u.table === backupJobs)).toBe(false);
  });

  it("leaves lastRunAt alone when every source was skipped", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ type: "bind", source: "/srv/app-a/data" })]);

    await runBackup("job-1");

    expect(updated.some((u) => u.table === backupJobs)).toBe(false);
  });
});

// Stopping an app used to end its backups: the scheduled run filtered it out
// and nothing said so. Its volumes are still on disk, so they are still
// captured — only a dump, which needs a container to run in, waits.
describe("runBackup — stopped apps", () => {
  const dumpVolume = (over: Record<string, unknown> = {}) =>
    volume({ backupSpec: { kind: "postgres", service: "db" }, backupStrategy: "dump", ...over });

  it("archives a stopped app's volumes on a scheduled run", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a", "org-1", "stopped")] }));
    volumesPerApp([volume({ name: "a-data" })]);

    const results = await runBackup("job-1");

    expect(results.map((r) => [r.volumeName, r.outcome])).toEqual([["a-data", "success"]]);
    expect(committed).toHaveLength(1);
  });

  it("still leaves a missing app out — it has no volumes left to capture", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a", "org-1", "missing")] }));
    volumesPerApp([volume({ name: "a-data" })]);

    const results = await runBackup("job-1");

    expect(results).toEqual([]);
    expect(volumesFindMany).not.toHaveBeenCalled();
  });

  it("records a dump against a stopped app as skipped, not failed", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a", "org-1", "stopped")] }));
    volumesPerApp([dumpVolume({ name: "pgdata" })]);

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("skipped");
    expect(results[0].error).toMatch(/needs a running container/);
    expect(updated.some((u) => u.set.status === "skipped")).toBe(true);
    expect(updated.some((u) => u.set.status === "failed")).toBe(false);
  });

  it("fails a dump the same way as before when the app is running", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([dumpVolume({ name: "pgdata" })]);

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/No running container/);
  });

  it("does not raise a failure for a run that is only waiting on a stopped app", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a", "org-1", "stopped")] }));
    volumesPerApp([dumpVolume({ name: "pgdata" })]);

    await runBackup("job-1");

    expect(emitted("backup.failed")).toHaveLength(0);
  });

  it("captures what it can beside a paused dump", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a", "org-1", "stopped")] }));
    volumesPerApp([dumpVolume({ name: "pgdata" }), volume({ id: "vol-2", name: "redis" })]);

    const results = await runBackup("job-1");

    expect(results.map((r) => [r.volumeName, r.outcome])).toEqual([
      ["pgdata", "skipped"],
      ["redis", "success"],
    ]);
    expect(updated.some((u) => u.table === backupJobs && u.set.lastRunAt instanceof Date)).toBe(true);
  });
});

// A cron-triggered run was invisible from start to finish. Progress rides the
// event bus per source, and must stay incapable of touching the run itself.
describe("runBackup — progress events", () => {
  it("announces every source as it starts, numbered against the run total", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [jobApp("app-a"), jobApp("app-b")] }),
    );
    volumesPerApp(
      [volume({ name: "a-data" }), volume({ id: "vol-2", name: "a-uploads" })],
      [volume({ id: "vol-3", name: "b-data" })],
    );

    await runBackup("job-1");

    expect(emitted("backup.progress").map((e) => [e.appName, e.volumeName, e.index, e.total])).toEqual([
      ["app-a", "a-data", 1, 3],
      ["app-a", "a-uploads", 2, 3],
      ["app-b", "b-data", 3, 3],
    ]);
  });

  it("announces a source before archiving it, not after", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "a-data" }), volume({ id: "vol-2", name: "a-uploads" })]);
    // Archives completed at the moment each progress event fires.
    const archivedAtEmit: number[] = [];
    emitMock.mockImplementation((_orgId: string, event: { type: string }) => {
      if (event.type === "backup.progress") archivedAtEmit.push(uploadMock.mock.calls.length);
    });

    await runBackup("job-1");

    expect(archivedAtEmit).toEqual([0, 1]);
  });

  it("carries the app id so the UI can name what is running", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "a-data" })]);

    await runBackup("job-1");

    expect(emitted("backup.progress")[0]).toMatchObject({
      type: "backup.progress",
      jobId: "job-1",
      jobName: "Nightly",
      appId: "app-a",
      appName: "app-a",
      index: 1,
      total: 1,
    });
  });

  it("announces a skipped source too, so the count never stalls", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([
      volume({ name: "data" }),
      volume({ id: "vol-2", name: "uploads", type: "bind", source: "/srv/uploads" }),
    ]);

    await runBackup("job-1");

    expect(emitted("backup.progress").map((e) => e.volumeName)).toEqual(["data", "uploads"]);
  });

  it("names an unattached volume after itself", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({
        backupJobApps: [],
        backupJobVolumes: [{ volume: { ...volume({ name: "postgres" }), appId: null } }],
      }),
    );

    await runBackup("job-1");

    expect(emitted("backup.progress")[0]).toMatchObject({ appId: null, appName: "postgres" });
  });

  it("reports to the org owning each app when the job spans orgs", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({
        organizationId: null,
        backupJobApps: [jobApp("app-a", "org-1"), jobApp("app-b", "org-2")],
      }),
    );
    volumesPerApp([volume({ name: "a-data" })], [volume({ id: "vol-2", name: "b-data" })]);

    await runBackup("job-1");

    expect(emittedOrgs("backup.progress")).toEqual(["org-1", "org-2"]);
  });

  it("stays quiet when there is no org to report to", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({
        organizationId: null,
        backupJobApps: [],
        backupJobVolumes: [{ volume: { ...volume({ name: "postgres" }), appId: null } }],
      }),
    );

    const results = await runBackup("job-1");

    expect(emitted("backup.progress")).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it("finishes the run when the bus throws on every emit", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ notifyOnSuccess: true }));
    volumesPerApp([volume({ name: "a-data" }), volume({ id: "vol-2", name: "a-uploads" })]);
    emitMock.mockImplementation(() => {
      throw new Error("redis down");
    });

    const results = await runBackup("job-1");

    expect(results.map((r) => r.outcome)).toEqual(["success", "success"]);
    expect(committed).toHaveLength(2);
    expect(updated.filter((u) => u.set.status === "success")).toHaveLength(2);
  });
});

// A tar.gz of an empty directory is ~87 bytes, under the size floor. Whether
// that is correct output or a truncated archive is decided by what the
// archiving container reported about the source, never by the size.
describe("runBackup — tiny archives", () => {
  const TINY = tarGz({ dirs: ["./"] });

  /** Replaces the archiving container with a specific body and empty-source verdict. */
  function stubArchive(opts: { bytes: Buffer; empty?: boolean }) {
    spawnMock.mockImplementation((file: string, argv: string[]) => {
      if (file === "docker" && argv[0] === "run" && opts.empty) {
        writeFileSync(join(workDirOf(argv), MARKERS_FILE), `${EMPTY_SOURCE_MARKER}\n`);
      }
      return fakeChild({ stdout: opts.bytes });
    });
  }

  it("uses an archive under the size floor", () => {
    expect(TINY.length).toBeLessThan(MIN_VALID_GZIP_BYTES);
  });

  it("succeeds when the container reports the source empty", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY, empty: true });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("success");
    expect(committed).toHaveLength(1);
    const row = updated.find((u) => u.set.status === "success")!;
    expect(String(row.set.log)).toMatch(/is empty — archived 0 files/);
  });

  it("fails on a truncated archive, which reports nothing about the source", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(new RegExp(`${TINY.length}-byte file`));
    expect(committed).toHaveLength(0);
  });

  it("fails a corrupt archive even when the source was empty", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY.subarray(0, TINY.length - 8), empty: true });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/gzip check failed/);
    expect(committed).toHaveLength(0);
  });

  it("still fails a tiny dump — an empty dump is never correct output", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([
      volume({
        backupStrategy: "dump",
        backupMeta: { dumpCmd: "docker exec pg pg_dump -U u db", restoreCmd: "" },
      }),
    ]);
    spawnMock.mockImplementation(() => fakeChild({ stdout: Buffer.alloc(0) }));

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/too small to be valid/);
  });
});

describe("runBackup — cross-org links", () => {
  it("skips an app that does not belong to the job's org", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [jobApp("app-a"), jobApp("app-b", "org-2")] }),
    );
    volumesPerApp([{ id: "v1", name: "data", mountPath: "/data", persistent: true }], []);

    await runBackup("job-1");

    const runs = dockerRuns();
    expect(runs.some((r) => r.join(" ").includes("app-b"))).toBe(false);
  });

  it("keeps every app for an instance-level job, which legitimately spans orgs", async () => {
    backupJobsFindFirst.mockResolvedValue(
      job({ organizationId: null, backupJobApps: [jobApp("app-a", "org-1"), jobApp("app-b", "org-2")] }),
    );
    volumesPerApp(
      [{ id: "v1", name: "data", mountPath: "/data", persistent: true }],
      [{ id: "v2", name: "data", mountPath: "/data", persistent: true }],
    );

    const results = await runBackup("job-1");
    expect(results).toHaveLength(2);
  });
});

describe("runBackup — deleted apps (#867)", () => {
  it("snapshots the app's name and org on each row", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume()]);

    await runBackup("job-1");

    expect(inserted[0]).toMatchObject({ appId: "app-a", appName: "app-a", organizationId: "org-1" });
  });

  it("still applies retention once every app on the job is deleted", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [], keepLast: 1 }));
    const day = (d: number) => new Date(Date.UTC(2026, 0, d));
    backupsFindMany.mockResolvedValue(
      [3, 2, 1].map((d) => ({
        id: `b-${d}`,
        appId: "app-gone",
        volumeName: "data",
        status: "success",
        storagePath: `gone/data-${d}.tar.gz`,
        finishedAt: day(d),
      })),
    );

    const results = await runBackup("job-1");

    expect(results).toEqual([]);
    expect(updated.filter((u) => u.set.status === "pruned")).toHaveLength(1);
    expect(emitted("backup.failed")).toHaveLength(0);
  });
});

// Opted-in bind dirs are often legitimately empty. Empty only fails once the
// source has held data, which is what a missing mount looks like.
describe("runBackup — empty bind sources", () => {
  const bindVolume = (overrides: Record<string, unknown> = {}) =>
    volume({
      name: "data",
      type: "bind",
      source: "/mnt/docker/outline/data",
      backupSelection: "include",
      ...overrides,
    });

  /** Answers the bind preflight with the given emptiness; archives otherwise. */
  function stubBind(empty: boolean) {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const [file, argv] = args as [string, string[]];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (file === "docker" && argv[0] === "run" && argv.some((a) => a.endsWith(":/data:ro"))) {
        const stdout = `${DIRECTORY_SOURCE_MARKER}\n${empty ? `${EMPTY_SOURCE_MARKER}\n` : ""}`;
        return cb(null, { stdout, stderr: "" });
      }
      execImpl(...args);
    });
  }

  it("skips an empty source that has never been backed up", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([bindVolume()]);
    stubBind(true);

    const results = await runBackup("job-1");

    expect(results[0]).toMatchObject({
      outcome: "skipped",
      emptySource: true,
      error: expect.stringMatching(/empty, never backed up/),
    });
    expect(committed).toHaveLength(0);
    const row = updated.find((u) => u.set.status === "skipped")!;
    expect(String(row.set.log)).toMatch(/has never been backed up with data/);
    expect(updated.some((u) => u.set.status === "failed")).toBe(false);
    expect(emitted("backup.failed")).toHaveLength(0);
  });

  it("fails an empty source that has held data before", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([bindVolume()]);
    backupsFindFirst.mockResolvedValue({ id: "b-prior" });
    stubBind(true);

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/is empty — refusing to record/);
    expect(emitted("backup.failed")).toHaveLength(1);
  });

  it("archives a non-empty source as before", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([bindVolume()]);
    stubBind(false);

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("success");
    expect(committed).toHaveLength(1);
    expect(backupsFindFirst).not.toHaveBeenCalled();
  });

  it("leaves the job's success alone", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ notifyOnSuccess: true }));
    volumesPerApp([volume({ id: "vol-1", name: "pgdata" }), bindVolume({ id: "vol-2" })]);
    stubBind(true);

    const results = await runBackup("job-1");

    expect(results.map((r) => [r.volumeName, r.outcome])).toEqual([
      ["pgdata", "success"],
      ["data", "skipped"],
    ]);
    expect(runSucceeded(results)).toBe(true);
    expect(emitted("backup.failed")).toHaveLength(0);
    expect(emitted("backup.success")).toHaveLength(1);
    expect(updated.some((u) => u.table === backupJobs && u.set.lastRunAt instanceof Date)).toBe(true);
  });

  it("still counts other skips against the job", () => {
    const base = { backupId: "b", appId: "a", volumeName: "v", sizeBytes: 0, storagePath: "", durationMs: 0 };
    expect(runSucceeded([{ ...base, outcome: "success" }, { ...base, outcome: "skipped" }])).toBe(false);
    expect(runSucceeded([])).toBe(false);
  });
});

// #876: an app switched off stops being backed up on schedule, even on a job it shares.
describe("runBackup — backup switch", () => {
  const off = (id: string) => {
    const row = jobApp(id);
    return { app: { ...row.app, backupsEnabled: false } };
  };

  it("skips an app switched off on a scheduled run and refreshes lastRunAt for the rest", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [jobApp("app-a"), off("app-b")] }));
    volumesPerApp([volume({ name: "a-data" })], [volume({ id: "vol-2", name: "b-data" })]);

    const results = await runBackup("job-1");

    expect(results.map((r) => r.volumeName)).toEqual(["a-data"]);
    expect(updated.some((u) => u.table === backupJobs && u.set.lastRunAt instanceof Date)).toBe(true);
  });

  it("follows an org switched off", async () => {
    const row = jobApp("app-a");
    backupJobsFindFirst.mockResolvedValue(
      job({ backupJobApps: [{ app: { ...row.app, organization: { slug: "acme", backupsEnabled: false } } }] }),
    );
    volumesPerApp([volume({ name: "a-data" })]);

    expect(await runBackup("job-1")).toEqual([]);
  });

  it("still backs up an app switched off when asked by name", async () => {
    backupJobsFindFirst.mockResolvedValue(job({ backupJobApps: [off("app-a")] }));
    volumesPerApp([volume({ name: "a-data" })]);

    const results = await runBackup("job-1", { appIds: ["app-a"] });

    expect(results.map((r) => r.volumeName)).toEqual(["a-data"]);
  });
});
