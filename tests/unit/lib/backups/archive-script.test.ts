// The empty-source marker is the only thing separating a correct 87-byte
// archive from a truncated one, so it is driven here against real directories.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ARCHIVE_HAS_FILES_MARKER,
  EMPTY_SOURCE_MARKER,
  EXCLUDE_LIST_FILE,
  FILE_PAYLOAD_NAME,
  MIN_VALID_GZIP_BYTES,
  PROTECT_LIST_FILE,
  buildFileBackupScript,
  buildFileRestoreScript,
  buildTarBackupScript,
  buildTarRestoreScript,
} from "@/lib/backups/archive";
import { buildFindExclusionArgv } from "@/lib/backups/exclusions";

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

// ---------------------------------------------------------------------------
// Exclusions, driven against real directories.
//
// `find` resolves the patterns, so all tar ever sees is a list of literal
// paths. busybox 1.37, GNU tar 1.35 and bsdtar 3.5 agree on those. They do not
// agree on operator globs, which is why none reach tar.
// ---------------------------------------------------------------------------

function makeTree(files: Record<string, string>): { dataDir: string; backupDir: string } {
  const root = mkdtempSync(join(ROOT, "excl-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "backup");
  mkdirSync(dataDir);
  mkdirSync(backupDir);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dataDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return { dataDir, backupDir };
}

function backupWith(dataDir: string, backupDir: string, patterns: string[]) {
  return spawnSync(
    "sh",
    [
      "-c",
      buildTarBackupScript(dataDir, backupDir),
      "vardo-backup",
      ...buildFindExclusionArgv(patterns),
    ],
    { encoding: "utf8" },
  );
}

function members(backupDir: string): string[] {
  return spawnSync("tar", ["tzf", join(backupDir, "volume.tar.gz")], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map((member) => member.replace(/\/$/, ""))
    .sort();
}

const TREE = {
  "keep.db": "irreplaceable",
  "Cache/blob": "regenerable",
  "config/Cache/blob": "regenerable",
  "config/settings": "irreplaceable",
};

describe("buildTarBackupScript exclusions", () => {
  it("archives everything when no patterns are passed", () => {
    const { dataDir, backupDir } = makeTree(TREE);

    const proc = backupWith(dataDir, backupDir, []);

    expect(proc.status, proc.stderr).toBe(0);
    expect(members(backupDir)).toContain("./Cache/blob");
    expect(proc.stdout).toContain(ARCHIVE_HAS_FILES_MARKER);
  });

  it("drops every directory a slashless pattern names, at any depth", () => {
    const { dataDir, backupDir } = makeTree(TREE);

    const proc = backupWith(dataDir, backupDir, ["Cache"]);

    expect(proc.status, proc.stderr).toBe(0);
    expect(members(backupDir)).toEqual([".", "./config", "./config/settings", "./keep.db"]);
    expect(
      readFileSync(join(backupDir, EXCLUDE_LIST_FILE), "utf8").split("\n").filter(Boolean).sort(),
    ).toEqual(["./Cache", "./config/Cache"]);
  });

  it("drops only the named path when the pattern holds a slash", () => {
    const { dataDir, backupDir } = makeTree(TREE);

    const proc = backupWith(dataDir, backupDir, ["config/Cache"]);

    expect(proc.status, proc.stderr).toBe(0);
    expect(members(backupDir)).toContain("./Cache/blob");
    expect(members(backupDir)).not.toContain("./config/Cache/blob");
  });

  it("leaves the source untouched", () => {
    const { dataDir, backupDir } = makeTree(TREE);

    backupWith(dataDir, backupDir, ["Cache"]);

    expect(readFileSync(join(dataDir, "Cache", "blob"), "utf8")).toBe("regenerable");
  });

  // The size floor cannot see this: the directory tree alone clears 100 bytes.
  it("withholds the has-files marker when the patterns took every file", () => {
    const { dataDir, backupDir } = makeTree(TREE);

    const proc = backupWith(dataDir, backupDir, ["*"]);

    expect(proc.status, proc.stderr).toBe(0);
    expect(proc.stdout).not.toContain(ARCHIVE_HAS_FILES_MARKER);
    expect(members(backupDir)).toEqual(["."]);
  });
});

describe("tar restore keeps the paths the archive left out", () => {
  /** An archive taken with exclusions, over a live copy that has moved on. */
  function stageRestore(patterns: string[]) {
    const source = makeTree({
      "keep.db": "v1",
      "Cache/blob": "at backup time",
      "config/settings": "v1",
    });
    expect(backupWith(source.dataDir, source.backupDir, patterns).status).toBe(0);

    const live = makeTree({
      "keep.db": "v2",
      "Cache/blob": "current cache",
      "config/settings": "v2",
      "since.txt": "written after the backup",
    });
    cpSync(join(source.backupDir, "volume.tar.gz"), join(live.backupDir, "volume.tar.gz"));
    return live;
  }

  function restore(dataDir: string, backupDir: string) {
    return spawnSync("sh", ["-c", buildTarRestoreScript(dataDir, backupDir)], { encoding: "utf8" });
  }

  it("restores the archived portion and leaves the excluded path as found", () => {
    const { dataDir, backupDir } = stageRestore(["Cache"]);
    writeFileSync(join(backupDir, PROTECT_LIST_FILE), "Cache\n");

    const proc = restore(dataDir, backupDir);

    expect(proc.status, proc.stderr).toBe(0);
    expect(readFileSync(join(dataDir, "keep.db"), "utf8")).toBe("v1");
    expect(readFileSync(join(dataDir, "config", "settings"), "utf8")).toBe("v1");
    // Untouched, rather than deleted as absent from the archive.
    expect(readFileSync(join(dataDir, "Cache", "blob"), "utf8")).toBe("current cache");
    // Everything the archive does not name is still cleared.
    expect(readdirSync(dataDir).sort()).toEqual(["Cache", "config", "keep.db"]);
  });

  it("reinstates a nested path into a directory the archive did restore", () => {
    const { dataDir, backupDir } = stageRestore(["config/settings"]);
    writeFileSync(join(backupDir, PROTECT_LIST_FILE), "config/settings\n");

    const proc = restore(dataDir, backupDir);

    expect(proc.status, proc.stderr).toBe(0);
    expect(readFileSync(join(dataDir, "config", "settings"), "utf8")).toBe("v2");
    expect(readFileSync(join(dataDir, "Cache", "blob"), "utf8")).toBe("at backup time");
  });

  it("carries on when a protected path is no longer at the destination", () => {
    const { dataDir, backupDir } = stageRestore(["Cache"]);
    writeFileSync(join(backupDir, PROTECT_LIST_FILE), "Cache\ngone\n");

    const proc = restore(dataDir, backupDir);

    expect(proc.status, proc.stderr).toBe(0);
    expect(readFileSync(join(dataDir, "Cache", "blob"), "utf8")).toBe("current cache");
  });

  it("refuses a protected path that would reach outside the volume", () => {
    const { dataDir, backupDir } = stageRestore(["Cache"]);
    writeFileSync(join(backupDir, PROTECT_LIST_FILE), "../../etc\n");

    const proc = restore(dataDir, backupDir);

    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toMatch(/refusing protected path/);
    // Refused before the clear, so nothing was lost.
    expect(readFileSync(join(dataDir, "since.txt"), "utf8")).toBe("written after the backup");
  });

  it("clears the destination as before when the archive left nothing out", () => {
    const { dataDir, backupDir } = stageRestore([]);

    const proc = restore(dataDir, backupDir);

    expect(proc.status, proc.stderr).toBe(0);
    expect(readdirSync(dataDir).sort()).toEqual(["Cache", "config", "keep.db"]);
    expect(readFileSync(join(dataDir, "Cache", "blob"), "utf8")).toBe("at backup time");
  });
});
