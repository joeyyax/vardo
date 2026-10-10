// Archive encryption through the engine (#877): what reaches storage, what the
// row records, and that restore, download and prune handle encrypted and
// legacy plaintext archives.

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
vi.mock("@/lib/docker/volume-owner", () => ({
  volumeOwnerProblem: vi.fn().mockResolvedValue(null),
  appFamily: vi.fn(async (id: string) => [id]),
  foreignVolumeHolders: vi.fn().mockResolvedValue([]),
}));
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { copyFile } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { VALID_ARCHIVE, fakeChild, recordingUpload } from "./fake-archive";

const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-archive-enc-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;
const KEY = "d".repeat(64);

const ARCHIVE_BYTES = VALID_ARCHIVE;
const sha = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

const {
  backupJobsFindFirst,
  volumesFindMany,
  volumesFindFirst,
  backupsFindMany,
  backupsFindFirst,
  execFileMock,
  spawnMock,
  uploaded,
  stored,
  deleteMock,
  getDownloadUrlMock,
  inserted,
  updated,
} = vi.hoisted(() => ({
  backupJobsFindFirst: vi.fn(),
  volumesFindMany: vi.fn(),
  volumesFindFirst: vi.fn(),
  backupsFindMany: vi.fn(),
  backupsFindFirst: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  uploaded: [] as { key: string; bytes: Buffer }[],
  stored: { path: "" },
  deleteMock: vi.fn(),
  getDownloadUrlMock: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobs: { findFirst: backupJobsFindFirst },
      volumes: { findMany: volumesFindMany, findFirst: volumesFindFirst },
      backups: { findMany: backupsFindMany, findFirst: backupsFindFirst },
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push(values);
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updated.push(set);
        },
      }),
    }),
  },
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: execFileMock,
  spawn: spawnMock,
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/docker/client", () => ({
  listContainers: vi.fn().mockResolvedValue([]),
  inspectContainer: vi.fn().mockResolvedValue({ mounts: [] }),
  dockerRequest: vi.fn().mockResolvedValue([]),
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
}));
vi.mock("@/lib/docker/resolve-env", () => ({
  resolveDefaultEnv: vi.fn().mockResolvedValue({ id: "env-1", name: "production" }),
}));
vi.mock("@/lib/crypto/key-escrow", () => ({ probeDecryptability: vi.fn() }));
vi.mock("@/lib/backups/run-lease", () => ({ holdBackupLease: async () => async () => {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({
    uploadStream: recordingUpload(uploaded),
    download: vi.fn(async (_key: string, dest: string) => {
      await copyFile(stored.path, dest);
    }),
    delete: deleteMock,
    getDownloadUrl: getDownloadUrlMock,
  }),
}));

import {
  downloadBackupToTemp,
  getBackupDownloadUrl,
  pruneBackups,
  restoreBackup,
  runBackup,
} from "@/lib/backups/engine";
import { ARCHIVE_MAGIC, encryptArchiveFile } from "@/lib/backups/archive-crypto";
import { fingerprintMasterKey } from "@/lib/crypto/key-fingerprint";

const execImpl = (...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
  cb(null, { stdout: "", stderr: "" });
};

function restoreRan(): boolean {
  return execFileMock.mock.calls.some(([file, argv]) => {
    const line = (argv as string[]).join(" ");
    return file === "docker" && line.includes("tar xzf");
  });
}

function job() {
  return {
    id: "job-1",
    name: "Nightly",
    organizationId: "org-1",
    notifyOnFailure: false,
    notifyOnSuccess: false,
    keepAll: true,
    target: { id: "tgt-1", type: "s3", config: {}, organizationId: "org-1" },
    backupJobApps: [{ app: { id: "app-a", name: "app-a", organizationId: "org-1", status: "active", organization: { slug: "acme" } } }],
    backupJobVolumes: [],
  };
}

function backupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk-1",
    appId: "app-1",
    volumeName: "data",
    storagePath: "acme/app/data/x.tar.gz",
    strategy: "tar",
    status: "success",
    checksum: sha(ARCHIVE_BYTES),
    sizeBytes: 700,
    archiveKey: null,
    target: { organizationId: "org-1" },
    app: { name: "myapp" },
    ...overrides,
  };
}

/** Write `plain` as the stored object, encrypted. Returns the row's key fields. */
async function storeEncrypted(plain: Buffer) {
  const src = join(BACKUPS_ROOT, "plain-src");
  stored.path = join(BACKUPS_ROOT, "stored.enc");
  writeFileSync(src, plain);
  const key = await encryptArchiveFile(src, stored.path, KEY);
  return { archiveKey: key.wrappedKey, archiveKeyFingerprint: key.keyFingerprint };
}

function storePlain(plain: Buffer) {
  stored.path = join(BACKUPS_ROOT, "stored.plain");
  writeFileSync(stored.path, plain);
}

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.ENCRYPTION_MASTER_KEY = KEY;
  inserted.length = 0;
  updated.length = 0;
  uploaded.length = 0;
  execFileMock.mockReset().mockImplementation(execImpl);
  spawnMock.mockReset().mockImplementation(() => fakeChild({ stdout: ARCHIVE_BYTES }));
  backupJobsFindFirst.mockReset().mockResolvedValue(job());
  volumesFindMany.mockReset().mockResolvedValue([
    { id: "vol-1", name: "data", mountPath: "/data", type: "named", source: null, persistent: true, backupStrategy: "tar", backupMeta: null },
  ]);
  volumesFindFirst.mockReset().mockResolvedValue({ backupStrategy: "tar", backupMeta: null });
  backupsFindMany.mockReset().mockResolvedValue([]);
  backupsFindFirst.mockReset();
  deleteMock.mockReset().mockResolvedValue(undefined);
  getDownloadUrlMock.mockReset().mockResolvedValue("https://bucket.example/presigned");
});

describe("runBackup — archive encryption", () => {
  it("uploads ciphertext and records the wrapped key, fingerprint and plaintext checksum", async () => {
    const [result] = await runBackup("job-1");

    expect(result.outcome).toBe("success");
    expect(uploaded).toHaveLength(1);
    const { bytes } = uploaded[0];
    expect(bytes.subarray(0, 8).equals(ARCHIVE_MAGIC)).toBe(true);
    expect(bytes.includes(ARCHIVE_BYTES.subarray(0, 64))).toBe(false);

    const success = updated.find((u) => u.status === "success")!;
    expect(success.archiveKeyFingerprint).toBe(fingerprintMasterKey(KEY));
    expect(typeof success.archiveKey).toBe("string");
    expect(bytes.includes(Buffer.from(success.archiveKey as string, "base64"))).toBe(true);
    expect(success.checksum).toBe(sha(ARCHIVE_BYTES));
    expect(success.sizeBytes).toBe(bytes.length);
  });

  it("names an encrypted archive with an .enc suffix", async () => {
    await runBackup("job-1");

    expect(uploaded[0].key).toMatch(/\.tar\.gz\.enc$/);
  });

  it("keeps the plain name when the archive is not encrypted", async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    await runBackup("job-1");

    expect(uploaded[0].key).toMatch(/\.tar\.gz$/);
  });

  it("uploads plaintext with no key recorded when no master key is set", async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    await runBackup("job-1");

    expect(uploaded[0].bytes.equals(ARCHIVE_BYTES)).toBe(true);
    const success = updated.find((u) => u.status === "success")!;
    expect(success.archiveKey).toBeNull();
    expect(success.log).toMatch(/uploading the archive unencrypted/);
  });

  it("a backup it wrote restores through the engine", async () => {
    await runBackup("job-1");
    const success = updated.find((u) => u.status === "success")!;
    stored.path = join(BACKUPS_ROOT, "roundtrip.enc");
    writeFileSync(stored.path, uploaded[0].bytes);
    backupsFindFirst.mockResolvedValue(
      backupRow({ checksum: success.checksum, sizeBytes: success.sizeBytes, archiveKey: success.archiveKey }),
    );

    const restored = await restoreBackup("bk-1");

    expect(restored.success).toBe(true);
    expect(restored.log).toMatch(/Archive decrypted and authenticated/);
    expect(restored.log).toMatch(/Checksum verified/);
    expect(restoreRan()).toBe(true);
  });
});

describe("restoreBackup — encrypted and legacy archives", () => {
  it("restores a legacy plaintext archive", async () => {
    storePlain(ARCHIVE_BYTES);
    backupsFindFirst.mockResolvedValue(backupRow());

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/Archive is unencrypted/);
    expect(restoreRan()).toBe(true);
  });

  it("restores an .enc archive whose row predates the strategy column", async () => {
    const keyFields = await storeEncrypted(ARCHIVE_BYTES);
    backupsFindFirst.mockResolvedValue(backupRow({ ...keyFields, strategy: null, storagePath: "acme/app/data/x.tar.gz.enc" }));

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(restoreRan()).toBe(true);
  });

  it("waives the size floor for an encrypted archive of an empty source", async () => {
    const tiny = Buffer.alloc(40, 1);
    const keyFields = await storeEncrypted(tiny);
    backupsFindFirst.mockResolvedValue(backupRow({ ...keyFields, checksum: sha(tiny), sizeBytes: 200 }));

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
  });

  it("refuses a tampered archive before any restore command runs", async () => {
    const keyFields = await storeEncrypted(ARCHIVE_BYTES);
    const sealed = readFileSync(stored.path);
    sealed[sealed.length - 20] ^= 1;
    writeFileSync(stored.path, sealed);
    backupsFindFirst.mockResolvedValue(backupRow(keyFields));

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(result.log).toMatch(/failed authentication/);
    expect(restoreRan()).toBe(false);
  });

  it("refuses an archive under a different master key", async () => {
    const keyFields = await storeEncrypted(ARCHIVE_BYTES);
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    backupsFindFirst.mockResolvedValue(backupRow(keyFields));

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(result.log).toMatch(/wrapped by master key/);
    expect(restoreRan()).toBe(false);
  });

  it("refuses a plaintext object where the row records an encrypted one", async () => {
    storePlain(ARCHIVE_BYTES);
    backupsFindFirst.mockResolvedValue(backupRow({ archiveKey: "c29tZXRoaW5n" }));

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(result.log).toMatch(/not encrypted/);
    expect(restoreRan()).toBe(false);
  });
});

describe("download and prune", () => {
  it("never presigns an encrypted archive and downloads it decrypted", async () => {
    const keyFields = await storeEncrypted(ARCHIVE_BYTES);
    backupsFindFirst.mockResolvedValue(backupRow(keyFields));

    expect(await getBackupDownloadUrl("bk-1")).toBeNull();
    expect(getDownloadUrlMock).not.toHaveBeenCalled();

    const path = await downloadBackupToTemp("bk-1");
    expect(readFileSync(path).equals(ARCHIVE_BYTES)).toBe(true);
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it("still presigns a legacy plaintext archive", async () => {
    backupsFindFirst.mockResolvedValue(backupRow());
    expect(await getBackupDownloadUrl("bk-1")).toBe("https://bucket.example/presigned");
  });

  it("clears the wrapped key when a backup is pruned", async () => {
    backupJobsFindFirst.mockResolvedValue({ ...job(), keepAll: false, keepLast: 1 });
    backupsFindMany.mockResolvedValue([
      { id: "new", finishedAt: new Date(2026, 1, 2), appId: "a", volumeName: "data", storagePath: "k1" },
      { id: "old", finishedAt: new Date(2026, 1, 1), appId: "a", volumeName: "data", storagePath: "k2" },
    ]);

    expect(await pruneBackups("job-1")).toBe(1);
    expect(updated).toContainEqual({ status: "pruned", archiveKey: null });
  });
});
