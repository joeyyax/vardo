// The empty-source marker is the only thing separating a correct 87-byte
// archive from a truncated one, so it is driven here against real directories.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EMPTY_SOURCE_MARKER,
  MIN_VALID_GZIP_BYTES,
  buildTarBackupScript,
} from "@/lib/backups/archive";

const ROOT = mkdtempSync(join(tmpdir(), "vardo-archive-script-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeVolume(files: Record<string, string>): { dataDir: string; backupDir: string } {
  const root = mkdtempSync(join(ROOT, "vol-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "backup");
  mkdirSync(dataDir);
  mkdirSync(backupDir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dataDir, name), body);
  }
  return { dataDir, backupDir };
}

function run(dataDir: string, backupDir: string) {
  return spawnSync("sh", ["-c", buildTarBackupScript(dataDir, backupDir)], { encoding: "utf8" });
}

describe("buildTarBackupScript", () => {
  it("marks an empty volume and still writes a readable archive", () => {
    const { dataDir, backupDir } = makeVolume({});

    const proc = run(dataDir, backupDir);
    const archive = join(backupDir, "volume.tar.gz");

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain(EMPTY_SOURCE_MARKER);
    expect(spawnSync("gzip", ["-t", archive]).status).toBe(0);
  });

  it("leaves a volume with a dotfile unmarked", () => {
    const { dataDir, backupDir } = makeVolume({ ".env": "SECRET=1" });

    const proc = run(dataDir, backupDir);

    expect(proc.status).toBe(0);
    expect(proc.stdout).not.toContain(EMPTY_SOURCE_MARKER);
    expect(statSync(join(backupDir, "volume.tar.gz")).size).toBeGreaterThanOrEqual(
      MIN_VALID_GZIP_BYTES,
    );
  });

  it("fails rather than marking empty when the source does not exist", () => {
    const { backupDir } = makeVolume({});

    const proc = run(join(ROOT, "does-not-exist"), backupDir);

    expect(proc.status).not.toBe(0);
    expect(proc.stdout).not.toContain(EMPTY_SOURCE_MARKER);
  });
});

// ---------------------------------------------------------------------------
// Single-file bind sources, driven against real files.
// ---------------------------------------------------------------------------

import { buildFileBackupScript, buildFileRestoreScript, FILE_PAYLOAD_NAME } from "@/lib/backups/archive";
import { readFileSync } from "fs";

function makeFileVolume(body: string): { dataDir: string; backupDir: string; payload: string } {
  const root = mkdtempSync(join(ROOT, "file-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "backup");
  mkdirSync(dataDir);
  mkdirSync(backupDir);
  const payload = join(dataDir, FILE_PAYLOAD_NAME);
  writeFileSync(payload, body);
  return { dataDir, backupDir, payload };
}

describe("single-file archive round-trip", () => {
  it("restores byte-identical contents", () => {
    const original = '{"token":"secret","records":[1,2,3]}\n';
    const { dataDir, backupDir, payload } = makeFileVolume(original);

    const backup = spawnSync("sh", ["-c", buildFileBackupScript(dataDir, backupDir)]);
    expect(backup.status, backup.stderr?.toString()).toBe(0);
    expect(statSync(join(backupDir, "volume.tar.gz")).size).toBeGreaterThan(MIN_VALID_GZIP_BYTES);

    writeFileSync(payload, "clobbered");
    const restore = spawnSync("sh", ["-c", buildFileRestoreScript(dataDir, backupDir)]);
    expect(restore.status, restore.stderr?.toString()).toBe(0);

    expect(readFileSync(payload, "utf8")).toBe(original);
  });

  it("writes through the existing inode, since the destination is a mount point", () => {
    const { dataDir, backupDir, payload } = makeFileVolume("v1\n");
    spawnSync("sh", ["-c", buildFileBackupScript(dataDir, backupDir)]);
    const before = statSync(payload).ino;

    writeFileSync(payload, "v2\n");
    spawnSync("sh", ["-c", buildFileRestoreScript(dataDir, backupDir)]);

    // A replace would give a new inode and, on a real bind mount, EBUSY.
    expect(statSync(payload).ino).toBe(before);
    expect(readFileSync(payload, "utf8")).toBe("v1\n");
  });

  it("leaves the original alone when the archive is unreadable", () => {
    const { dataDir, backupDir, payload } = makeFileVolume("intact\n");
    writeFileSync(join(backupDir, "volume.tar.gz"), "this is not a gzip stream");

    const restore = spawnSync("sh", ["-c", buildFileRestoreScript(dataDir, backupDir)]);
    expect(restore.status).not.toBe(0);
    expect(readFileSync(payload, "utf8")).toBe("intact\n");
  });

  it("refuses a directory archive pointed at a file destination", () => {
    const { dataDir: dirData, backupDir } = makeVolume({ "a.txt": "x" });
    spawnSync("sh", ["-c", buildTarBackupScript(dirData, backupDir)]);

    const fileVol = makeFileVolume("intact\n");
    const restore = spawnSync("sh", ["-c", buildFileRestoreScript(fileVol.dataDir, backupDir)]);
    expect(restore.status).not.toBe(0);
    expect(restore.stderr.toString()).toMatch(/does not hold a single file/);
    expect(readFileSync(fileVol.payload, "utf8")).toBe("intact\n");
  });
});
