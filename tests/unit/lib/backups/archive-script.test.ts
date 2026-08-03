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
