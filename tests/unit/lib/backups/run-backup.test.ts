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

const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-runbackup-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;

const ARCHIVE_BYTES = Buffer.alloc(512, 7); // ≥100 bytes so verifyArchive passes

const {
  backupJobsFindFirst,
  volumesFindMany,
  backupsFindMany,
  execFileMock,
  executeHooksMock,
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
  execFileMock: vi.fn(),
  executeHooksMock: vi.fn(),
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
      backups: { findMany: backupsFindMany },
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
vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: executeHooksMock }));
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
  createBackupStorage: () => ({ upload: uploadMock, delete: vi.fn(), download: vi.fn() }),
}));

import { runBackup } from "@/lib/backups/engine";
import { EMPTY_SOURCE_MARKER } from "@/lib/backups/archive";
import { backupJobs } from "@/lib/db/schema";

// Stands in for docker/bash: writes the archive the engine then verifies.
const execImpl = (...args: unknown[]) => {
  const [file, argv] = args as [string, string[]];
  const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;

  if (file === "docker" && argv[0] === "run") {
    const mount = argv.find((a) => typeof a === "string" && a.endsWith(":/backup"));
    if (mount) writeFileSync(join(mount.slice(0, -":/backup".length), "volume.tar.gz"), ARCHIVE_BYTES);
  }
  if (file === "bash") {
    const dest = /> "([^"]+)"/.exec(argv[1]);
    if (dest) writeFileSync(dest[1], ARCHIVE_BYTES);
  }

  cb(null, { stdout: "", stderr: "" });
};

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

function jobApp(id: string, organizationId = "org-1") {
  return { app: { id, name: id, organizationId, organization: { slug: "acme" } } };
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
  return execFileMock.mock.calls
    .filter((c) => c[0] === "docker" && (c[1] as string[])[0] === "run")
    .map((c) => c[1] as string[]);
}

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

beforeAll(() => {
  uploadMock.mockResolvedValue({ sizeBytes: 512 });
});

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
  execFileMock.mockReset().mockImplementation(execImpl);
  emitMock.mockReset();
  volumesFindMany.mockReset();
  backupsFindMany.mockReset().mockResolvedValue([]);
  executeHooksMock.mockReset().mockResolvedValue({ allowed: true, results: [] });
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
    expect(uploadMock).not.toHaveBeenCalled();
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
    expect(execFileMock.mock.calls.some((c) => c[0] === "bash")).toBe(true);
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
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(new Error("docker run failed"), null);
    });

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
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(updated.filter((u) => u.set.status === "success")).toHaveLength(2);
  });
});

// A tar.gz of an empty directory is ~87 bytes, under the size floor. Whether
// that is correct output or a truncated archive is decided by what the
// archiving container reported about the source, never by the size.
describe("runBackup — tiny archives", () => {
  const TINY = Buffer.alloc(87, 0);

  /** Replaces the archiving container with a specific body, stdout and gzip verdict. */
  function stubArchive(opts: { bytes: Buffer; stdout?: string; gzipOk?: boolean }) {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const [file, argv] = args as [string, string[]];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;

      if (file === "docker" && argv[0] === "run") {
        const mount = argv.find((a) => typeof a === "string" && a.endsWith(":/backup"))!;
        writeFileSync(join(mount.slice(0, -":/backup".length), "volume.tar.gz"), opts.bytes);
        return cb(null, { stdout: opts.stdout ?? "", stderr: "" });
      }
      if (file === "gzip" && opts.gzipOk === false) {
        return cb(new Error("unexpected end of file"), null);
      }
      cb(null, { stdout: "", stderr: "" });
    });
  }

  it("succeeds when the container reports the source empty", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY, stdout: `${EMPTY_SOURCE_MARKER}\n` });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("success");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const row = updated.find((u) => u.set.status === "success")!;
    expect(String(row.set.log)).toMatch(/is empty — archived 0 files/);
  });

  it("fails on a truncated archive, which reports nothing about the source", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/87-byte file/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("fails a corrupt archive even when the source was empty", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([volume({ name: "letsencrypt" })]);
    stubArchive({ bytes: TINY, stdout: EMPTY_SOURCE_MARKER, gzipOk: false });

    const results = await runBackup("job-1");

    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toMatch(/gzip -t failed/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("still fails a tiny dump — an empty dump is never correct output", async () => {
    backupJobsFindFirst.mockResolvedValue(job());
    volumesPerApp([
      volume({
        backupStrategy: "dump",
        backupMeta: { dumpCmd: "docker exec pg pg_dump -U u db", restoreCmd: "" },
      }),
    ]);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const [file, argv] = args as [string, string[]];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (file === "bash") {
        const dest = /> "([^"]+)"/.exec(argv[1])!;
        writeFileSync(dest[1], TINY);
      }
      cb(null, { stdout: "", stderr: "" });
    });

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
