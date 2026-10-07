// A backup whose archive is gone from storage downloads as a 404, not a 500,
// and leaves no temp dir behind (#870).

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { S3Client } from "@aws-sdk/client-s3";

const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-missing-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;
const TARGET_ROOT = mkdtempSync(join(tmpdir(), "vardo-missing-target-"));

const { backupsFindFirst, execFileAsyncMock } = vi.hoisted(() => ({
  backupsFindFirst: vi.fn(),
  execFileAsyncMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { query: { backups: { findFirst: backupsFindFirst } } } }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execFileAsyncMock }));

const { downloadBackupToTemp } = await import("@/lib/backups/engine");
const { ArchiveMissingError } = await import("@/lib/backups/storage-port");
const { LocalBackupStorage } = await import("@/lib/backups/storage-local");
const { SshBackupStorage } = await import("@/lib/backups/storage-ssh");
const { S3BackupStorage } = await import("@/lib/backups/storage-s3");

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  rmSync(TARGET_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  execFileAsyncMock.mockReset();
});

const s3 = () =>
  new S3BackupStorage({ bucket: "b", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" });

describe("a missing archive", () => {
  it("is reported by the local adapter", async () => {
    const storage = new LocalBackupStorage({ path: TARGET_ROOT });
    await expect(storage.download("gone.tar.gz", join(BACKUPS_ROOT, "x"))).rejects.toBeInstanceOf(ArchiveMissingError);
  });

  it("is reported by the SSH adapter from scp's stderr", async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("Command failed: scp"), { stderr: "scp: /srv/gone.tar.gz: No such file or directory\n" }),
    );
    const storage = new SshBackupStorage({ host: "nas", username: "u", path: "/srv" });
    await expect(storage.download("gone.tar.gz", join(BACKUPS_ROOT, "x"))).rejects.toBeInstanceOf(ArchiveMissingError);
  });

  it("leaves other SSH failures as they are", async () => {
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error("Command failed: scp"), { stderr: "Permission denied" }));
    const storage = new SshBackupStorage({ host: "nas", username: "u", path: "/srv" });
    await expect(storage.download("k", join(BACKUPS_ROOT, "x"))).rejects.not.toBeInstanceOf(ArchiveMissingError);
  });

  it("is reported by the S3 adapter on download", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
      Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }),
    );
    await expect(s3().download("gone.tar.gz", join(BACKUPS_ROOT, "x"))).rejects.toBeInstanceOf(ArchiveMissingError);
  });

  it("is reported by the S3 adapter before presigning", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
      Object.assign(new Error("UnknownError"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    await expect(s3().getDownloadUrl("gone.tar.gz")).rejects.toBeInstanceOf(ArchiveMissingError);
  });

  it("presigns an object that exists", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ $metadata: {} } as never);
    await expect(s3().getDownloadUrl("here.tar.gz")).resolves.toMatch(/here\.tar\.gz/);
  });
});

describe("downloadBackupToTemp", () => {
  it("removes its temp dir when the download fails", async () => {
    backupsFindFirst.mockResolvedValue({
      id: "b-1",
      storagePath: "web/gone.tar.gz",
      target: { type: "local", config: { path: TARGET_ROOT } },
    });

    await expect(downloadBackupToTemp("b-1")).rejects.toBeInstanceOf(ArchiveMissingError);
    expect(readdirSync(BACKUPS_ROOT).filter((f) => f.startsWith(".tmp-download-"))).toEqual([]);
  });
});
