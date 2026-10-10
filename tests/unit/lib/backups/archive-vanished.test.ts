// A live SQLite volume drops its -wal and -shm files between tar's listing and its read.
// Busybox tar skips them and exits 1; the scripts must tell that apart from a real failure.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import {
  MARKERS_FILE,
  VANISHED_LIST_FILE,
  buildTarBackupScript,
  buildTarStreamScript,
  parseVanishedPaths,
} from "@/lib/backups/archive";
import { TarMemberScanner } from "@/lib/backups/archive-stream";
import { buildFindExclusionArgv } from "@/lib/backups/exclusions";

const ROOT = mkdtempSync(join(tmpdir(), "vardo-archive-vanished-"));
const REAL_TAR = spawnSync("sh", ["-c", "command -v tar"]).stdout.toString().trim();

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Runs the real tar, then reports and exits as told.
const FAKE_TAR = `#!/bin/sh
"$REAL_TAR" "$@" || exit $?
[ -n "$FAKE_TAR_ERR" ] && printf '%s\\n' "$FAKE_TAR_ERR" >&2
exit "\${FAKE_TAR_RC:-0}"
`;

function setup(): { dataDir: string; backupDir: string; bin: string } {
  const root = mkdtempSync(join(ROOT, "vol-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "backup");
  const bin = join(root, "bin");
  for (const d of [dataDir, backupDir, bin]) mkdirSync(d);
  writeFileSync(join(dataDir, "logs.db"), "x".repeat(4096));
  writeFileSync(join(bin, "tar"), FAKE_TAR);
  chmodSync(join(bin, "tar"), 0o755);
  return { dataDir, backupDir, bin };
}

function run(script: string, bin: string, err: string, rc: number, argv: string[] = []) {
  const proc = spawnSync("sh", ["-c", script, "vardo-backup", ...argv], {
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_TAR,
      FAKE_TAR_ERR: err,
      FAKE_TAR_RC: String(rc),
      COPYFILE_DISABLE: "1",
    },
  });
  return { status: proc.status, stderr: proc.stderr.toString(), archive: proc.stdout };
}

const BUSYBOX_VANISHED = [
  "tar: ./logs.db-shm: No such file or directory",
  "tar: can't open './logs.db-wal': No such file or directory",
  "tar: error exit delayed from previous errors",
].join("\n");

describe("buildTarStreamScript with files that vanish mid-archive", () => {
  it("succeeds, keeps a readable archive and lists what was left out", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, BUSYBOX_VANISHED, 1);

    expect(r.status).toBe(0);
    const scanner = new TarMemberScanner();
    scanner.write(gunzipSync(r.archive));
    expect(scanner.hasFiles).toBe(true);
    expect(parseVanishedPaths(readFileSync(join(backupDir, VANISHED_LIST_FILE), "utf8")).sort()).toEqual([
      "logs.db-shm",
      "logs.db-wal",
    ]);
    expect(existsSync(join(backupDir, MARKERS_FILE))).toBe(false);
  });

  it("tolerates GNU tar's changed-while-read warning", () => {
    const { dataDir, backupDir, bin } = setup();
    const err = "tar: ./logs.db: file changed as we read it\ntar: Exiting with failure status due to previous errors";
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, err, 1);

    expect(r.status).toBe(0);
    expect(parseVanishedPaths(readFileSync(join(backupDir, VANISHED_LIST_FILE), "utf8"))).toEqual(["logs.db"]);
  });

  it("does the same when exclusions are in play", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, BUSYBOX_VANISHED, 1, buildFindExclusionArgv(["cache"]));

    expect(r.status).toBe(0);
  });

  it("tolerates a file vanishing while find lists exclusions", () => {
    const { dataDir, backupDir, bin } = setup();
    writeFileSync(join(bin, "find"), `#!/bin/sh\necho "find: ./tmp.db-journal: No such file or directory" >&2\nexit 1\n`);
    chmodSync(join(bin, "find"), 0o755);
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "", 0, buildFindExclusionArgv(["cache"]));

    expect(r.status).toBe(0);
    expect(parseVanishedPaths(readFileSync(join(backupDir, VANISHED_LIST_FILE), "utf8"))).toEqual(["tmp.db-journal"]);
  });

  it("fails when find hits a real error", () => {
    const { dataDir, backupDir, bin } = setup();
    writeFileSync(join(bin, "find"), `#!/bin/sh\necho "find: ./private: Permission denied" >&2\nexit 1\n`);
    chmodSync(join(bin, "find"), 0o755);
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "", 0, buildFindExclusionArgv(["cache"]));

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Permission denied");
  });

  it("fails on a permission error mixed in with vanished files", () => {
    const { dataDir, backupDir, bin } = setup();
    const err = `tar: ./secret: Permission denied\n${BUSYBOX_VANISHED}`;
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, err, 1);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Permission denied");
  });

  it("fails on a full disk", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "tar: write error: No space left on device", 1);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No space left on device");
  });

  it("fails on GNU tar's fatal exit code even when the messages look harmless", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "tar: ./x: No such file or directory", 2);

    expect(r.status).toBe(2);
  });

  it("fails on exit 1 with nothing said", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "", 1);

    expect(r.status).toBe(1);
  });

  it("fails when tar can't start its compressor", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarStreamScript(dataDir, backupDir), bin, "tar: can't execute 'gzip': No such file or directory", 1);

    expect(r.status).toBe(1);
  });
});

describe("buildTarBackupScript with files that vanish mid-archive", () => {
  it("still writes the pre-restore snapshot", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarBackupScript(dataDir, backupDir), bin, BUSYBOX_VANISHED, 1);

    expect(r.status).toBe(0);
    expect(gunzipSync(readFileSync(join(backupDir, "volume.tar.gz"))).length).toBeGreaterThan(0);
  });

  it("fails on a real error", () => {
    const { dataDir, backupDir, bin } = setup();
    const r = run(buildTarBackupScript(dataDir, backupDir), bin, "tar: ./db: Permission denied", 1);

    expect(r.status).toBe(1);
  });
});

describe("parseVanishedPaths", () => {
  it("reads busybox and GNU messages and drops the leading ./", () => {
    const body = [
      "tar: ./a/b.db-wal: No such file or directory",
      "tar: can't open './c': No such file or directory",
      "tar: ./d: Cannot stat: No such file or directory",
      "tar: ./e: file removed before we read it",
      "tar: ./a/b.db-wal: No such file or directory",
      "",
    ].join("\n");
    expect(parseVanishedPaths(body)).toEqual(["a/b.db-wal", "c", "d", "e"]);
  });
});
