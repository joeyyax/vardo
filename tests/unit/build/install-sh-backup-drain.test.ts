import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// The legacy `vardo update` stops the console. It waits for the console's backup work first, up to a bound.

let dir: string;
let lib: string;

// Each `docker exec` reads the next count from the queue; the last one sticks.
const FAKE_DOCKER = `#!/bin/sh
q="$FAKE/counts"
[ -f "$q" ] || exit 1
head -n 1 "$q"
[ "$(wc -l < "$q")" -gt 1 ] && sed -i.bak 1d "$q"
exit 0
`;

function sh(script: string, counts: string[] | null, env: Record<string, string> = {}) {
  const fake = join(dir, "fake");
  rmSync(fake, { recursive: true, force: true });
  mkdirSync(fake);
  if (counts) writeFileSync(join(fake, "counts"), `${counts.join("\n")}\n`);
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE: fake,
      VARDO_DIR: join(dir, "vardo"),
      VARDO_BACKUP_DRAIN_POLL: "0",
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-backup-drain-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/docker"), FAKE_DOCKER);
  chmodSync(join(dir, "bin/docker"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("wait_for_backup_work", () => {
  it("goes straight on when the console has no backup work", () => {
    const r = sh("wait_for_backup_work; echo stopped", ["0"]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("Waiting");
    expect(r.out).toContain("stopped");
  });

  it("goes straight on when Redis can't say", () => {
    const r = sh("wait_for_backup_work; echo stopped", null);
    expect(r.status).toBe(0);
    expect(r.out).toContain("stopped");
  });

  it("waits until the backup work finishes", () => {
    const r = sh("wait_for_backup_work; echo stopped", ["2", "1", "1", "0"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Waiting up to 20 minutes");
    expect(r.out).toContain("Backup work finished");
    expect(r.out.indexOf("finished")).toBeLessThan(r.out.indexOf("stopped"));
  });

  it("stops anyway once VARDO_BACKUP_DRAIN_MINUTES runs out", () => {
    const r = sh("wait_for_backup_work; echo stopped", ["1"], { VARDO_BACKUP_DRAIN_MINUTES: "0" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("still running after 0 minutes");
    expect(r.out).toContain("stopped");
  });
});
