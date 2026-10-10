// Progress publishing is the only new thing standing between a backup job and
// its archives. If the event bus module cannot even be loaded, the run must
// still capture and record every volume.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
vi.mock("@/lib/docker/volume-owner", () => ({
  volumeOwnerProblem: vi.fn().mockResolvedValue(null),
  appFamily: vi.fn(async (id: string) => [id]),
  foreignVolumeHolders: vi.fn().mockResolvedValue([]),
}));
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-busfail-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;


const {
  backupJobsFindFirst,
  volumesFindMany,
  backupsFindMany,
  execFileMock,
  spawnMock,
  uploadMock,
  inserted,
  updated,
} = vi.hoisted(() => ({
  backupJobsFindFirst: vi.fn(),
  volumesFindMany: vi.fn(),
  backupsFindMany: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  uploadMock: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  updated: [] as { set: Record<string, unknown> }[],
}));

// The bus is unreachable — importing it blows up, as it would if Redis config
// or a transitive dependency were broken at runtime.
vi.mock("@/lib/notifications/dispatch", () => {
  throw new Error("bus module unavailable");
});

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
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updated.push({ set });
        },
      }),
    }),
  },
}));
vi.mock("child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));
vi.mock("@/lib/docker/client", () => ({ listContainers: vi.fn(), inspectContainer: vi.fn() }));
vi.mock("@/lib/docker/resolve-env", () => ({
  resolveDefaultEnv: vi.fn().mockResolvedValue({ id: "env-1", name: "production" }),
}));
vi.mock("@/lib/backups/run-lease", () => ({ holdBackupLease: async () => async () => {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({ uploadStream: uploadMock, delete: vi.fn(), download: vi.fn() }),
}));

import { runBackup } from "@/lib/backups/engine";
import { VALID_ARCHIVE, fakeChild, recordingUpload } from "./fake-archive";

const committed: { key: string; bytes: Buffer }[] = [];

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
  committed.length = 0;
  uploadMock.mockReset().mockImplementation(recordingUpload(committed));
  spawnMock.mockReset().mockImplementation(() => fakeChild({ stdout: VALID_ARCHIVE }));
  backupsFindMany.mockReset().mockResolvedValue([]);
  execFileMock.mockReset().mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
    cb(null, { stdout: "", stderr: "" });
  });
  volumesFindMany.mockReset().mockResolvedValue([
    { id: "vol-1", name: "data", mountPath: "/data", type: "named", source: null, persistent: true, backupStrategy: "tar", backupMeta: null },
    { id: "vol-2", name: "uploads", mountPath: "/uploads", type: "named", source: null, persistent: true, backupStrategy: "tar", backupMeta: null },
  ]);
  backupJobsFindFirst.mockResolvedValue({
    id: "job-1",
    name: "Nightly",
    organizationId: "org-1",
    notifyOnFailure: true,
    notifyOnSuccess: true,
    keepAll: true,
    keepLast: null,
    keepHourly: null,
    keepDaily: null,
    keepWeekly: null,
    keepMonthly: null,
    keepYearly: null,
    target: { id: "tgt-1", type: "s3", config: {}, organizationId: "org-1" },
    backupJobApps: [
      { app: { id: "app-a", name: "app-a", organizationId: "org-1", organization: { slug: "acme" } } },
    ],
    backupJobVolumes: [],
  });
});

describe("runBackup — bus unavailable", () => {
  it("captures every volume anyway", async () => {
    const results = await runBackup("job-1");

    expect(results.map((r) => [r.volumeName, r.outcome])).toEqual([
      ["data", "success"],
      ["uploads", "success"],
    ]);
    expect(committed).toHaveLength(2);
    expect(inserted.every((row) => row.status === "running")).toBe(true);
    expect(updated.filter((u) => u.set.status === "success")).toHaveLength(2);
  });
});
